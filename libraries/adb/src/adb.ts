import type { Consumable, ReadableWritablePair } from "@yume-chan/stream-extra";
import { ConcatStringStream, DecodeUtf8Stream } from "@yume-chan/stream-extra";
import type { ValueOrPromise } from "@yume-chan/struct";

import type { AdbBanner } from "./banner.js";
import type { AdbFrameBuffer } from "./commands/index.js";
import {
    AdbPower,
    AdbReverseCommand,
    AdbSubprocess,
    AdbSync,
    AdbTcpIpCommand,
    escapeArg,
    framebuffer,
} from "./commands/index.js";
import type { AdbFeature } from "./features.js";

export interface AdbSocket
    extends ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>,
        Closeable {
    readonly service: string;
}

export type AdbIncomingSocketHandler = (
    socket: AdbSocket,
) => ValueOrPromise<void>;

export interface Closeable {
    close(): ValueOrPromise<void>;
}

export interface AdbTransport extends Closeable {
    readonly serial: string;

    readonly maxPayloadSize: number;

    readonly banner: AdbBanner;

    readonly disconnected: Promise<void>;

    connect(service: string): ValueOrPromise<AdbSocket>;

    addReverseTunnel(
        handler: AdbIncomingSocketHandler,
        address?: string,
    ): ValueOrPromise<string>;

    removeReverseTunnel(address: string): ValueOrPromise<void>;

    clearReverseTunnels(): ValueOrPromise<void>;
}

export class Adb implements Closeable {
    readonly transport: AdbTransport;

    get serial() {
        return this.transport.serial;
    }

    get maxPayloadSize() {
        return this.transport.maxPayloadSize;
    }

    get banner() {
        return this.transport.banner;
    }

    get disconnected() {
        return this.transport.disconnected;
    }

    readonly subprocess: AdbSubprocess;
    readonly power: AdbPower;
    readonly reverse: AdbReverseCommand;
    readonly tcpip: AdbTcpIpCommand;

    constructor(transport: AdbTransport) {
        this.transport = transport;

        this.subprocess = new AdbSubprocess(this);
        this.power = new AdbPower(this);
        this.reverse = new AdbReverseCommand(this);
        this.tcpip = new AdbTcpIpCommand(this);
    }

    supportsFeature(feature: AdbFeature): boolean {
        return this.banner.features.includes(feature);
    }

    async createSocket(service: string): Promise<AdbSocket> {
        return this.transport.connect(service);
    }

    async createSocketAndWait(service: string): Promise<string> {
        const socket = await this.createSocket(service);
        return await socket.readable
            .pipeThrough(new DecodeUtf8Stream())
            .pipeThrough(new ConcatStringStream());
    }

    async getProp(key: string): Promise<string> {
        const stdout = await this.subprocess.spawnAndWaitLegacy([
            "getprop",
            key,
        ]);
        return stdout.trim();
    }

    async rm(...filenames: string[]): Promise<string> {
        // https://android.googlesource.com/platform/packages/modules/adb/+/1a0fb8846d4e6b671c8aa7f137a8c21d7b248716/client/adb_install.cpp#984
        const stdout = await this.subprocess.spawnAndWaitLegacy([
            "rm",
            ...filenames.map((arg) => escapeArg(arg)),
            "</dev/null",
        ]);
        return stdout;
    }

    async sync(): Promise<AdbSync> {
        const socket = await this.createSocket("sync:");
        return new AdbSync(this, socket);
    }

    async framebuffer(): Promise<AdbFrameBuffer> {
        return framebuffer(this);
    }

    async close(): Promise<void> {
        await this.transport.close();
    }
}
