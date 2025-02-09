import http from 'http';
import querystring from 'querystring';
import uWebSockets from 'uWebSockets.js';

import { DummyServer, ErrorCode, matchMaker, Transport, debugAndPrintError, spliceOne } from '@colyseus/core';
import { uWebSocketClient, uWebSocketWrapper } from './uWebSocketClient';

export type TransportOptions = Omit<uWebSockets.WebSocketBehavior<any>, "upgrade" | "open" | "pong" | "close" | "message">;

type RawWebSocketClient = uWebSockets.WebSocket<any> & {
  url: string,
  query: string,
  headers: {[key: string]: string},
  connection: { remoteAddress: string },
};

export class uWebSocketsTransport extends Transport {
    public app: uWebSockets.TemplatedApp;

    protected clients: RawWebSocketClient[] = [];
    protected clientWrappers = new WeakMap<RawWebSocketClient, uWebSocketWrapper>();

    private _listeningSocket: any;

    constructor(options: TransportOptions = {}, appOptions: uWebSockets.AppOptions = {}) {
        super();

        this.app = (appOptions.cert_file_name && appOptions.key_file_name)
            ? uWebSockets.SSLApp(appOptions)
            : uWebSockets.App(appOptions);

        if (!options.maxBackpressure) {
            options.maxBackpressure = 1024 * 1024;
        }

        if (!options.compression) {
            options.compression = uWebSockets.DISABLED;
        }

        if (!options.maxPayloadLength) {
            options.maxPayloadLength = 1024 * 1024;
        }

        // https://github.com/colyseus/colyseus/issues/458
        // Adding a mock object for Transport.server
        if(!this.server) {
          this.server = new DummyServer();
        }

        this.app.ws('/*', {
            ...options,

            upgrade: (res, req, context) => {
                // get all headers
                const headers: {[id: string]: string} = {};
                req.forEach((key, value) => headers[key] = value);

                /* This immediately calls open handler, you must not use res after this call */
                /* Spell these correctly */
                res.upgrade(
                    {
                        url: req.getUrl(),
                        query: req.getQuery(),

                        // compatibility with @colyseus/ws-transport
                        headers,
                        connection: {
                          remoteAddress: Buffer.from(res.getRemoteAddressAsText()).toString()
                        }
                    },
                    req.getHeader('sec-websocket-key'),
                    req.getHeader('sec-websocket-protocol'),
                    req.getHeader('sec-websocket-extensions'),
                    context
                );
            },

            open: async (ws: RawWebSocketClient) => {
                // ws.pingCount = 0;
                await this.onConnection(ws);
            },

            // pong: (ws: RawWebSocketClient) => {
            //     ws.pingCount = 0;
            // },

            close: (ws: RawWebSocketClient, code: number, message: ArrayBuffer) => {
                // remove from client list
                spliceOne(this.clients, this.clients.indexOf(ws));

                const clientWrapper = this.clientWrappers.get(ws);
                if (clientWrapper) {
                  this.clientWrappers.delete(ws);

                  // emit 'close' on wrapper
                  clientWrapper.emit('close', code);
                }
            },

            message: (ws: RawWebSocketClient, message: ArrayBuffer, isBinary: boolean) => {
                // emit 'close' on wrapper
                this.clientWrappers.get(ws)?.emit('message', Buffer.from(message.slice(0)));
            },

        });

        this.registerMatchMakeRequest();
    }

    public listen(port: number, hostname?: string, backlog?: number, listeningListener?: () => void) {
        const callback = (listeningSocket: any) => {
          this._listeningSocket = listeningSocket;
          listeningListener?.();
          this.server.emit("listening"); // Mocking Transport.server behaviour, https://github.com/colyseus/colyseus/issues/458
        };

        if (typeof(port) === "string") {
            // @ts-ignore
            this.app.listen_unix(callback, port);

        } else {
            this.app.listen(port, callback);

        }
        return this;
    }

    public shutdown() {
        if (this._listeningSocket) {
          uWebSockets.us_listen_socket_close(this._listeningSocket);
          this.server.emit("close"); // Mocking Transport.server behaviour, https://github.com/colyseus/colyseus/issues/458
        }
    }

    public simulateLatency(milliseconds: number) {
        const originalRawSend = uWebSocketClient.prototype.raw;
        uWebSocketClient.prototype.raw = function() {
          setTimeout(() => originalRawSend.apply(this, arguments), milliseconds);
        }
    }

    protected async onConnection(rawClient: RawWebSocketClient) {
        const wrapper = new uWebSocketWrapper(rawClient);
        // keep reference to client and its wrapper
        this.clients.push(rawClient);
        this.clientWrappers.set(rawClient, wrapper);

        const query = rawClient.query;
        const url = rawClient.url;
        const searchParams = querystring.parse(query);

        const sessionId = searchParams.sessionId as string;
        const processAndRoomId = url.match(/\/[a-zA-Z0-9_\-]+\/([a-zA-Z0-9_\-]+)$/);
        const roomId = processAndRoomId && processAndRoomId[1];

        const room = matchMaker.getRoomById(roomId);
        const client = new uWebSocketClient(sessionId, wrapper);

        //
        // TODO: DRY code below with all transports
        //

        try {
            if (!room || !room.hasReservedSeat(sessionId, searchParams.reconnectionToken as string)) {
                throw new Error('seat reservation expired.');
            }

            await room._onJoin(client, rawClient as unknown as http.IncomingMessage);

        } catch (e) {
            debugAndPrintError(e);

            // send error code to client then terminate
            client.error(e.code, e.message, () => rawClient.close());
        }
    }

    protected registerMatchMakeRequest() {

        // TODO: DRY with Server.ts
        const matchmakeRoute = 'matchmake';
        const allowedRoomNameChars = /([a-zA-Z_\-0-9]+)/gi;

        const writeHeaders = (req: uWebSockets.HttpRequest, res: uWebSockets.HttpResponse) => {
            // skip if aborted
            if (res.aborted) { return; }

            const headers = Object.assign(
                {},
                matchMaker.controller.DEFAULT_CORS_HEADERS,
                matchMaker.controller.getCorsHeaders.call(undefined, req)
            );

            for (const header in headers) {
                res.writeHeader(header, headers[header].toString());
            }

            return true;
        }

        const writeError = (res: uWebSockets.HttpResponse, error: { code: number, error: string }) => {
            // skip if aborted
            if (res.aborted) { return; }

            res.writeStatus("406 Not Acceptable");
            res.end(JSON.stringify(error));
        }

        const onAborted = (res: uWebSockets.HttpResponse) => {
          res.aborted = true;
        };

        this.app.options("/matchmake/*", (res, req) => {
            res.onAborted(() => onAborted(res));

            if (writeHeaders(req, res)) {
              res.writeStatus("204 No Content");
              res.end();
            }
        });


        // @ts-ignore
        this.app.post("/matchmake/*", (res, req) => {
            res.onAborted(() => onAborted(res));

            // do not accept matchmaking requests if already shutting down
            if (matchMaker.isGracefullyShuttingDown) {
              return res.close();
            }

            writeHeaders(req, res);
            res.writeHeader('Content-Type', 'application/json');

            const url = req.getUrl();
            const matchedParams = url.match(allowedRoomNameChars);
            const matchmakeIndex = matchedParams.indexOf(matchmakeRoute);

            // read json body
            this.readJson(res, async (clientOptions) => {
                try {
                    if (clientOptions === undefined) {
                      throw new Error("invalid JSON input");
                    }

                    const method = matchedParams[matchmakeIndex + 1];
                    const roomName = matchedParams[matchmakeIndex + 2] || '';

                    const response = await matchMaker.controller.invokeMethod(method, roomName, clientOptions);
                    if (!res.aborted) {
                      res.writeStatus("200 OK");
                      res.end(JSON.stringify(response));
                    }

                } catch (e) {
                    debugAndPrintError(e);
                    writeError(res, {
                        code: e.code || ErrorCode.MATCHMAKE_UNHANDLED,
                        error: e.message
                    });
                }

            });
        });

        // this.app.any("/*", (res, req) => {
        //     res.onAborted(() => onAborted(req));
        //     res.writeStatus("200 OK");
        // });

        this.app.get("/matchmake/*", async (res, req) => {
            res.onAborted(() => onAborted(res));

            writeHeaders(req, res);
            res.writeHeader('Content-Type', 'application/json');

            const url = req.getUrl();
            const matchedParams = url.match(allowedRoomNameChars);
            const roomName = matchedParams.length > 1 ? matchedParams[matchedParams.length - 1] : "";

            try {
                const response = await matchMaker.controller.getAvailableRooms(roomName || '')
                if (!res.aborted) {
                  res.writeStatus("200 OK");
                  res.end(JSON.stringify(response));
                }

            } catch (e) {
                debugAndPrintError(e);
                writeError(res, {
                    code: e.code || ErrorCode.MATCHMAKE_UNHANDLED,
                    error: e.message
                });
            }
        });
    }

    /* Helper function for reading a posted JSON body */
    /* Extracted from https://github.com/uNetworking/uWebSockets.js/blob/master/examples/JsonPost.js */
    private readJson(res: uWebSockets.HttpResponse, cb: (json: any) => void) {
        let buffer: any;
        /* Register data cb */
        res.onData((ab, isLast) => {
            let chunk = Buffer.from(ab);
            if (isLast) {
                let json;
                if (buffer) {
                    try {
                        // @ts-ignore
                        json = JSON.parse(Buffer.concat([buffer, chunk]));
                    } catch (e) {
                        /* res.close calls onAborted */
                        // res.close();
                        cb(undefined);
                        return;
                    }
                    cb(json);
                } else {
                    try {
                        // @ts-ignore
                        json = JSON.parse(chunk);
                    } catch (e) {
                        /* res.close calls onAborted */
                        // res.close();
                        cb(undefined);
                        return;
                    }
                    cb(json);
                }
            } else {
                if (buffer) {
                    buffer = Buffer.concat([buffer, chunk]);
                } else {
                    buffer = Buffer.concat([chunk]);
                }
            }
        });
    }
}
