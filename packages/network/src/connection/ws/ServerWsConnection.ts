import { ReadyState, AbstractWsConnection } from './AbstractWsConnection'
import { PeerInfo } from '../PeerInfo'
import { DisconnectionCode, DisconnectionReason } from './AbstractWsEndpoint'
import { Logger } from "@streamr/utils"
import WebSocket from 'ws'
import util from 'util'
import stream from 'stream'

export const logger = new Logger(module)

export class ServerWsConnection extends AbstractWsConnection {
    private readonly socket: WebSocket
    private readonly duplexStream: stream.Duplex
    private readonly remoteAddress: string | undefined

    constructor(socket: WebSocket, duplexStream: stream.Duplex, remoteAddress: string | undefined, peerInfo: PeerInfo) {
        super(peerInfo)
        this.socket = socket
        this.duplexStream = duplexStream
        this.remoteAddress = remoteAddress
    }

    close(code: DisconnectionCode, reason: DisconnectionReason): void {
        try {
            this.socket.close(code, reason)
        } catch (e) {
            logger.error('Failed to close connection', e)
        }
    }

    terminate(): void {
        try {
            this.socket.terminate()
        } catch (e) {
            logger.error('Failed to terminate connection', e)
        }
    }

    getBufferedAmount(): number {
        return this.socket.bufferedAmount
    }

    getReadyState(): ReadyState {
        return this.socket.readyState
    }

    sendPing(): void {
        this.socket.ping()
    }

    async send(message: string): Promise<void> {
        const readyState = this.getReadyState()
        if (this.getReadyState() !== 1) {
            throw new Error(`cannot send, readyState is ${readyState}`)
        }
        try {
            await util.promisify((cb: any) => this.duplexStream.write(message, cb))()
        } catch (err) {
            return Promise.reject(err)
        }
    }

    getRemoteAddress(): string | undefined {
        return this.remoteAddress
    }
}
