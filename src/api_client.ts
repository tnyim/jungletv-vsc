'use strict';

import { grpc } from "@improbable-eng/grpc-web";
import type { Request } from "@improbable-eng/grpc-web/dist/typings/invoke";
import type { ProtobufMessage } from "@improbable-eng/grpc-web/dist/typings/message";
import { MethodDefinition } from "@improbable-eng/grpc-web/dist/typings/service";
import * as vscode from 'vscode';

export type RequestBuilder<T> = (onUpdate: (update: T) => void, onEnd: (code: grpc.Code, msg: string) => void) => Request;

export interface StreamRequestController extends vscode.Disposable {
    rebuildAndReconnect: () => void;
    dispose: () => void;
}

export class APIClient {
    private host: string;
    private authToken: string | undefined;
    private authTokenRefreshedCallback: ((token: string, expiry: Date) => void) | undefined;

    constructor(host: string, authToken?: string, authTokenRefreshedCallback?: (token: string, expiry: Date) => void) {
        this.host = host;
        this.authToken = authToken;
        this.authTokenRefreshedCallback = authTokenRefreshedCallback;
    }

    async unaryRPC<TRequest extends ProtobufMessage, TResponse extends ProtobufMessage>(operation: MethodDefinition<TRequest, TResponse>, request: TRequest): Promise<TResponse> {
        return this.unaryRPCWithCancel(operation, request)[0];
    }

    unaryRPCWithCancel<TRequest extends ProtobufMessage, TResponse extends ProtobufMessage>(operation: MethodDefinition<TRequest, TResponse>, request: TRequest): [Promise<TResponse>, () => void] {
        let r: Request;
        let rej: (reason: any) => void;
        const cancel = function () {
            if (typeof r !== "undefined") r.close();
            if (typeof rej !== "undefined") rej("canceled by client");
        };
        return [new Promise<TResponse>((resolve, reject) => {
            rej = reject;
            r = grpc.invoke(operation, {
                request: request,
                host: this.host,
                metadata: new grpc.Metadata(this.authToken ? { "Authorization": this.authToken } : {}),
                onHeaders: (headers: grpc.Metadata): void => { this.processHeaders(headers); },
                onMessage: (message: TResponse) => resolve(message),
                onEnd: (code: grpc.Code, msg: string, trailers: grpc.Metadata) => {
                    if (code != grpc.Code.OK) {
                        reject(msg);
                    }
                }
            });
        }), cancel];
    }

    serverStreamingRPC<TRequest extends ProtobufMessage, TResponseItem extends ProtobufMessage>(
        operation: MethodDefinition<TRequest, TResponseItem>,
        request: TRequest,
        onMessage: (message: TResponseItem) => void,
        onEnd: (code: grpc.Code, msg: string) => void): Request {
        return grpc.invoke(operation, {
            request: request,
            host: this.host,
            metadata: new grpc.Metadata(this.authToken ? { "Authorization": this.authToken } : {}),
            onHeaders: (headers: grpc.Metadata): void => { this.processHeaders(headers); },
            onMessage: onMessage,
            onEnd: (code: grpc.Code, msg: string, trailers: grpc.Metadata) => {
                onEnd(code, msg);
            }
        });
    }

    private processHeaders(headers: grpc.Metadata) {
        if (headers.has("X-Replacement-Authorization-Token") && headers.has("X-Replacement-Authorization-Expiration") && this.authTokenRefreshedCallback) {
            this.authTokenRefreshedCallback(
                headers.get("X-Replacement-Authorization-Token")[0],
                new Date(headers.get("X-Replacement-Authorization-Expiration")[0]));
        }
    }

    consumeStreamRPC<T>(
        keepaliveInterval: number,
        reconnectionInterval: number,
        requestBuilder: RequestBuilder<T>, onUpdate: (arg: T) => void,
        onStatusChanged: (connected: boolean) => void = () => { }): StreamRequestController {
        let request: Request | undefined;
        let keepaliveTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let reconnectionTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let connected = true; // true makes us call statusChangedListener as soon as we get mounted

        function clearTimeouts() {
            if (keepaliveTimeoutHandle != null) {
                clearTimeout(keepaliveTimeoutHandle);
            }
            if (reconnectionTimeoutHandle != null) {
                clearTimeout(reconnectionTimeoutHandle);
            }
        }

        function makeRequest() {
            dispose();
            request = requestBuilder(handleUpdate, handleClose);
        }

        function dispose() {
            if (connected) {
                connected = false;
                onStatusChanged(connected);
            }
            if (request !== undefined) {
                request.close();
                request = undefined;
            }
            clearTimeouts();
        }

        function handleUpdate(update: T) {
            if (!connected) {
                connected = true;
                onStatusChanged(connected);
            }
            if (keepaliveTimeoutHandle != null) {
                clearTimeout(keepaliveTimeoutHandle);
            }
            keepaliveTimeoutHandle = setTimeout(makeRequest, keepaliveInterval);
            onUpdate(update);
        }

        function handleClose(code: grpc.Code, message: string) {
            request = undefined;
            connected = false;
            onStatusChanged(connected);
            // ideally this should use exponential backoff
            reconnectionTimeoutHandle = setTimeout(makeRequest, reconnectionInterval);
        }

        makeRequest();

        return {
            rebuildAndReconnect: makeRequest,
            dispose
        };
    }
}