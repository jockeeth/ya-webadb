import { ADB_SYNC_MAX_PACKET_SIZE } from "@yume-chan/adb";
import { AdbWebUsbBackend } from "@yume-chan/adb-backend-webusb";
import { AudioPlayer } from "@yume-chan/pcm-player";
import {
    AdbScrcpyClient,
    AdbScrcpyOptions2_0,
    AndroidScreenPowerMode,
    CodecOptions,
    DEFAULT_SERVER_PATH,
    ScrcpyAudioCodecId,
    ScrcpyDeviceMessageType,
    ScrcpyHoverHelper,
    ScrcpyInstanceId,
    ScrcpyLogLevel1_18,
    ScrcpyMediaStreamPacket,
    ScrcpyOptions2_0,
    clamp,
    h264ParseConfiguration,
} from "@yume-chan/scrcpy";
import { ScrcpyVideoDecoder } from "@yume-chan/scrcpy-decoder-tinyh264";
import SCRCPY_SERVER_VERSION from "@yume-chan/scrcpy/bin/version";
import {
    Consumable,
    DistributionStream,
    InspectStream,
    ReadableStream,
    WritableStream,
} from "@yume-chan/stream-extra";
import { action, autorun, makeAutoObservable, runInAction } from "mobx";
import { GLOBAL_STATE } from "../../state";
import { ProgressStream } from "../../utils";
import { fetchServer } from "./fetch-server";
import {
    AoaKeyboardInjector,
    KeyboardInjector,
    ScrcpyKeyboardInjector,
} from "./input";
import { MatroskaMuxingRecorder, RECORD_STATE } from "./recorder";
import { SETTING_STATE } from "./settings";

const NOOP = () => {
    // no-op
};

export class ScrcpyPageState {
    running = false;

    fullScreenContainer: HTMLDivElement | null = null;
    rendererContainer: HTMLDivElement | null = null;

    isFullScreen = false;

    logVisible = false;
    log: string[] = [];
    demoModeVisible = false;
    navigationBarVisible = true;

    width = 0;
    height = 0;
    rotation = 0;

    get rotatedWidth() {
        return STATE.rotation & 1 ? STATE.height : STATE.width;
    }
    get rotatedHeight() {
        return STATE.rotation & 1 ? STATE.width : STATE.height;
    }

    client: AdbScrcpyClient | undefined = undefined;
    hoverHelper: ScrcpyHoverHelper | undefined = undefined;
    keyboard: KeyboardInjector | undefined = undefined;
    audioPlayer: AudioPlayer | undefined = undefined;

    async pushServer() {
        const serverBuffer = await fetchServer();
        await AdbScrcpyClient.pushServer(
            GLOBAL_STATE.device!,
            new ReadableStream<Consumable<Uint8Array>>({
                start(controller) {
                    controller.enqueue(new Consumable(serverBuffer));
                    controller.close();
                },
            })
        );
    }

    decoder: ScrcpyVideoDecoder | undefined = undefined;
    fpsCounterIntervalId: any = undefined;
    fps = "0";

    connecting = false;
    serverTotalSize = 0;
    serverDownloadedSize = 0;
    debouncedServerDownloadedSize = 0;
    serverDownloadSpeed = 0;
    serverUploadedSize = 0;
    debouncedServerUploadedSize = 0;
    serverUploadSpeed = 0;

    constructor() {
        makeAutoObservable(this, {
            start: false,
            stop: action.bound,
            dispose: action.bound,
            setFullScreenContainer: action.bound,
            setRendererContainer: action.bound,
            clientPositionToDevicePosition: false,
        });

        autorun(() => {
            if (!GLOBAL_STATE.device) {
                this.dispose();
            }
        });

        if (typeof document === "object") {
            document.addEventListener("fullscreenchange", () => {
                if (!document.fullscreenElement) {
                    runInAction(() => {
                        this.isFullScreen = false;
                    });
                }
            });
        }

        autorun(() => {
            if (this.rendererContainer && this.decoder) {
                while (this.rendererContainer.firstChild) {
                    this.rendererContainer.firstChild.remove();
                }
                this.rendererContainer.appendChild(this.decoder.renderer);
            }
        });
    }

    start = async () => {
        if (!GLOBAL_STATE.device) {
            return;
        }

        this.audioPlayer = new AudioPlayer(48000);

        try {
            if (!SETTING_STATE.clientSettings.decoder) {
                throw new Error("No available decoder");
            }

            runInAction(() => {
                this.serverTotalSize = 0;
                this.serverDownloadedSize = 0;
                this.debouncedServerDownloadedSize = 0;
                this.serverUploadedSize = 0;
                this.debouncedServerUploadedSize = 0;
                this.connecting = true;
            });

            let intervalId = setInterval(
                action(() => {
                    this.serverDownloadSpeed =
                        this.serverDownloadedSize -
                        this.debouncedServerDownloadedSize;
                    this.debouncedServerDownloadedSize =
                        this.serverDownloadedSize;
                }),
                1000
            );

            let serverBuffer: Uint8Array;
            try {
                serverBuffer = await fetchServer(
                    action(([downloaded, total]) => {
                        this.serverDownloadedSize = downloaded;
                        this.serverTotalSize = total;
                    })
                );
                runInAction(() => {
                    this.serverDownloadSpeed =
                        this.serverDownloadedSize -
                        this.debouncedServerDownloadedSize;
                    this.debouncedServerDownloadedSize =
                        this.serverDownloadedSize;
                });
            } finally {
                clearInterval(intervalId);
            }

            intervalId = setInterval(
                action(() => {
                    this.serverUploadSpeed =
                        this.serverUploadedSize -
                        this.debouncedServerUploadedSize;
                    this.debouncedServerUploadedSize = this.serverUploadedSize;
                }),
                1000
            );

            try {
                await AdbScrcpyClient.pushServer(
                    GLOBAL_STATE.device!,
                    new ReadableStream<Consumable<Uint8Array>>({
                        start(controller) {
                            controller.enqueue(new Consumable(serverBuffer));
                            controller.close();
                        },
                    })
                        // In fact `pushServer` will pipe the stream through a DistributionStream,
                        // but without this pipeThrough, the progress will not be updated.
                        .pipeThrough(
                            new DistributionStream(ADB_SYNC_MAX_PACKET_SIZE)
                        )
                        .pipeThrough(
                            new ProgressStream(
                                action((progress) => {
                                    this.serverUploadedSize = progress;
                                })
                            )
                        )
                );

                runInAction(() => {
                    this.serverUploadSpeed =
                        this.serverUploadedSize -
                        this.debouncedServerUploadedSize;
                    this.debouncedServerUploadedSize = this.serverUploadedSize;
                });
            } finally {
                clearInterval(intervalId);
            }

            const decoderDefinition =
                SETTING_STATE.decoders.find(
                    (x) => x.key === SETTING_STATE.clientSettings.decoder
                ) ?? SETTING_STATE.decoders[0];
            const decoder = new decoderDefinition.Constructor();

            runInAction(() => {
                this.decoder = decoder;

                let lastFrameRendered = 0;
                let lastFrameSkipped = 0;
                this.fpsCounterIntervalId = setInterval(
                    action(() => {
                        const deltaRendered =
                            decoder.frameRendered - lastFrameRendered;
                        const deltaSkipped =
                            decoder.frameSkipped - lastFrameSkipped;
                        // prettier-ignore
                        this.fps = `${
                            deltaRendered
                        }${
                            deltaSkipped ? `+${deltaSkipped} skipped` : ""
                        }`;
                        lastFrameRendered = decoder.frameRendered;
                        lastFrameSkipped = decoder.frameSkipped;
                    }),
                    1000
                );
            });

            const videoCodecOptions = new CodecOptions();
            if (!SETTING_STATE.clientSettings.ignoreDecoderCodecArgs) {
                const capability = decoder.capabilities["h264"];
                if (capability) {
                    videoCodecOptions.value.profile = capability.maxProfile;
                    videoCodecOptions.value.level = capability.maxLevel;
                }
            }

            // Disabled due to https://github.com/Genymobile/scrcpy/issues/2841
            // Less recording delay
            // codecOptions.value.iFrameInterval = 1;
            // Less latency
            // codecOptions.value.intraRefreshPeriod = 10000;

            const options = new AdbScrcpyOptions2_0(
                new ScrcpyOptions2_0({
                    ...SETTING_STATE.settings,
                    logLevel: ScrcpyLogLevel1_18.Debug,
                    scid: ScrcpyInstanceId.random(),
                    sendDeviceMeta: false,
                    sendDummyByte: false,
                    videoCodecOptions,
                    audioCodec: "raw",
                })
            );

            runInAction(() => {
                this.log = [];
                this.log.push(
                    `[client] Server version: ${SCRCPY_SERVER_VERSION}`
                );
                this.log.push(
                    `[client] Server arguments: ${options
                        .serialize()
                        .join(" ")}`
                );
            });

            const client = await AdbScrcpyClient.start(
                GLOBAL_STATE.device!,
                DEFAULT_SERVER_PATH,
                SCRCPY_SERVER_VERSION,
                options
            );

            client.stdout.pipeTo(
                new WritableStream<string>({
                    write: action((line) => {
                        this.log.push(line);
                    }),
                })
            );

            RECORD_STATE.recorder = new MatroskaMuxingRecorder();
            RECORD_STATE.videoMetadata = undefined;
            RECORD_STATE.audioMetadata = undefined;

            client.videoStream.then(({ stream, metadata }) => {
                runInAction(() => {
                    RECORD_STATE.videoMetadata = metadata;
                });

                let lastKeyframe = 0n;
                const handler = new InspectStream<ScrcpyMediaStreamPacket>(
                    action((packet) => {
                        if (packet.type === "configuration") {
                            const { croppedWidth, croppedHeight } =
                                h264ParseConfiguration(packet.data);
                            this.log.push(
                                `[client] Video size changed: ${croppedWidth}x${croppedHeight}`
                            );

                            this.width = croppedWidth;
                            this.height = croppedHeight;
                        } else if (
                            packet.keyframe &&
                            packet.pts !== undefined
                        ) {
                            if (lastKeyframe) {
                                const interval =
                                    (Number(packet.pts - lastKeyframe) / 1000) |
                                    0;
                                this.log.push(
                                    `[client] Keyframe interval: ${interval}ms`
                                );
                            }
                            lastKeyframe = packet.pts!;
                        }
                    })
                );
                stream
                    .pipeThrough(handler)
                    .pipeTo(decoder.writable)
                    .catch((e) => {
                        console.log("video error", e);
                    });
            });

            client.audioStream?.then(async ({ stream, metadata }) => {
                if (metadata.codec !== ScrcpyAudioCodecId.Raw) {
                    return;
                }

                runInAction(() => {
                    RECORD_STATE.audioMetadata = metadata;
                });

                await this.audioPlayer?.start();
                stream
                    .pipeTo(
                        new WritableStream({
                            write: (data) => {
                                this.audioPlayer?.feed(data.data);
                            },
                        })
                    )
                    .catch(NOOP);
            });

            client.exit.then(this.dispose);

            client
                .deviceMessageStream!.pipeTo(
                    new WritableStream({
                        write(message) {
                            switch (message.type) {
                                case ScrcpyDeviceMessageType.Clipboard:
                                    window.navigator.clipboard.writeText(
                                        message.content
                                    );
                                    break;
                            }
                        },
                    })
                )
                .catch(() => {});

            if (SETTING_STATE.clientSettings.turnScreenOff) {
                await client.controlMessageSerializer!.setScreenPowerMode(
                    AndroidScreenPowerMode.Off
                );
            }

            runInAction(() => {
                this.client = client;
                this.hoverHelper = new ScrcpyHoverHelper();
                this.running = true;
            });

            if (GLOBAL_STATE.backend instanceof AdbWebUsbBackend) {
                this.keyboard = await AoaKeyboardInjector.register(
                    GLOBAL_STATE.backend.device
                );
            } else {
                this.keyboard = new ScrcpyKeyboardInjector(client);
            }
        } catch (e: any) {
            GLOBAL_STATE.showErrorDialog(e);
        } finally {
            runInAction(() => {
                this.connecting = false;
            });
        }
    };

    async stop() {
        // Request to close client first
        await this.client?.close();
        await this.dispose();
    }

    async dispose() {
        // Otherwise some packets may still arrive at decoder
        this.decoder?.dispose();
        this.decoder = undefined;

        if (RECORD_STATE.recording) {
            RECORD_STATE.recorder.stop();
            RECORD_STATE.recording = false;
        }

        this.keyboard?.dispose();
        this.keyboard = undefined;

        await this.audioPlayer?.stop();

        this.fps = "0";
        clearTimeout(this.fpsCounterIntervalId);

        if (this.isFullScreen) {
            document.exitFullscreen().catch(NOOP);
            this.isFullScreen = false;
        }

        this.client = undefined;
        this.running = false;
    }

    setFullScreenContainer(element: HTMLDivElement | null) {
        this.fullScreenContainer = element;
    }

    setRendererContainer(element: HTMLDivElement | null) {
        this.rendererContainer = element;
    }

    clientPositionToDevicePosition(clientX: number, clientY: number) {
        const viewRect = this.rendererContainer!.getBoundingClientRect();
        let pointerViewX = clamp((clientX - viewRect.x) / viewRect.width, 0, 1);
        let pointerViewY = clamp(
            (clientY - viewRect.y) / viewRect.height,
            0,
            1
        );

        if (this.rotation & 1) {
            [pointerViewX, pointerViewY] = [pointerViewY, pointerViewX];
        }
        switch (this.rotation) {
            case 1:
                pointerViewY = 1 - pointerViewY;
                break;
            case 2:
                pointerViewX = 1 - pointerViewX;
                pointerViewY = 1 - pointerViewY;
                break;
            case 3:
                pointerViewX = 1 - pointerViewX;
                break;
        }

        return {
            x: pointerViewX * this.width,
            y: pointerViewY * this.height,
        };
    }
}

export const STATE = new ScrcpyPageState();
