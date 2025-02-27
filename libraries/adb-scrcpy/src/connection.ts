import type { Adb } from "@yume-chan/adb";
import { AdbReverseNotSupportedError, NOOP } from "@yume-chan/adb";
import { delay } from "@yume-chan/async";
import type { Disposable } from "@yume-chan/event";
import type {
    Consumable,
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableWritablePair,
} from "@yume-chan/stream-extra";
import {
    BufferedReadableStream,
    TransformStream,
} from "@yume-chan/stream-extra";
import type { ValueOrPromise } from "@yume-chan/struct";

export interface AdbScrcpyConnectionOptions {
    scid: number;

    video: boolean;

    audio: boolean;

    /**
     * Whether to create a control stream
     */
    control: boolean;

    /**
     * In forward tunnel mode, read a byte from video socket on start to detect connection issues
     */
    sendDummyByte: boolean;
}

export const SCRCPY_SOCKET_NAME_PREFIX = "scrcpy";

export interface AdbScrcpyConnectionStreams {
    video?: ReadableStream<Uint8Array>;
    audio?: ReadableStream<Uint8Array>;
    control?: ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>;
}

export abstract class AdbScrcpyConnection implements Disposable {
    protected adb: Adb;

    protected options: AdbScrcpyConnectionOptions;

    protected socketName: string;

    constructor(adb: Adb, options: AdbScrcpyConnectionOptions) {
        this.adb = adb;
        this.options = options;
        this.socketName = this.getSocketName();
    }

    initialize(): ValueOrPromise<void> {
        // pure virtual method
    }

    protected getSocketName(): string {
        let socketName = "localabstract:" + SCRCPY_SOCKET_NAME_PREFIX;
        if (this.options.scid !== undefined && this.options.scid >= 0) {
            socketName += "_" + this.options.scid.toString(16).padStart(8, "0");
        }
        return socketName;
    }

    abstract getStreams(): ValueOrPromise<AdbScrcpyConnectionStreams>;

    dispose(): void {
        // pure virtual method
    }
}

export class AdbScrcpyForwardConnection extends AdbScrcpyConnection {
    #disposed = false;

    #connect(): Promise<
        ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>
    > {
        return this.adb.createSocket(this.socketName);
    }

    async #connectAndRetry(
        sendDummyByte: boolean,
    ): Promise<ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>> {
        for (let i = 0; !this.#disposed && i < 100; i += 1) {
            try {
                const stream = await this.#connect();
                if (sendDummyByte) {
                    // Can't guarantee the stream will preserve message boundaries,
                    // so buffer the stream
                    const buffered = new BufferedReadableStream(
                        stream.readable,
                    );
                    await buffered.readExactly(1);
                    return {
                        readable: buffered.release(),
                        writable: stream.writable,
                    };
                }
                return stream;
            } catch (e) {
                // Maybe the server is still starting
                await delay(100);
            }
        }
        throw new Error(`Can't connect to server after 100 retries`);
    }

    override async getStreams(): Promise<AdbScrcpyConnectionStreams> {
        let { sendDummyByte } = this.options;

        const streams: AdbScrcpyConnectionStreams = {};

        if (this.options.video) {
            const video = await this.#connectAndRetry(sendDummyByte);
            streams.video = video.readable;
            sendDummyByte = false;
        }

        if (this.options.audio) {
            const audio = await this.#connectAndRetry(sendDummyByte);
            streams.audio = audio.readable;
            sendDummyByte = false;
        }

        if (this.options.control) {
            const control = await this.#connectAndRetry(sendDummyByte);
            sendDummyByte = false;
            streams.control = control;
        }

        return streams;
    }

    override dispose(): void {
        this.#disposed = true;
    }
}

export class AdbScrcpyReverseConnection extends AdbScrcpyConnection {
    #streams!: ReadableStreamDefaultReader<
        ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>
    >;

    #address!: string;

    override async initialize(): Promise<void> {
        // try to unbind first
        await this.adb.reverse.remove(this.socketName).catch((e) => {
            if (e instanceof AdbReverseNotSupportedError) {
                throw e;
            }

            // Ignore other errors when unbinding
        });

        const queue = new TransformStream<
            ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>,
            ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>
        >();
        this.#streams = queue.readable.getReader();
        const writer = queue.writable.getWriter();
        this.#address = await this.adb.reverse.add(
            this.socketName,
            (socket) => {
                void writer.write(socket);
            },
        );
    }

    async #accept(): Promise<
        ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>
    > {
        return (await this.#streams.read()).value!;
    }

    async getStreams(): Promise<AdbScrcpyConnectionStreams> {
        const streams: AdbScrcpyConnectionStreams = {};

        if (this.options.video) {
            const video = await this.#accept();
            streams.video = video.readable;
        }

        if (this.options.audio) {
            const audio = await this.#accept();
            streams.audio = audio.readable;
        }

        if (this.options.control) {
            const control = await this.#accept();
            streams.control = control;
        }

        return streams;
    }

    override dispose() {
        // Don't await this!
        // `reverse.remove`'s response will never arrive
        // before we read all pending data from Scrcpy streams
        // NOOP: failed to remove reverse tunnel is not a big deal
        this.adb.reverse.remove(this.#address).catch(NOOP);
    }
}
