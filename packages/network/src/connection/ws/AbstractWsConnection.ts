import { PeerId, PeerInfo } from '../PeerInfo'
import {
    DisconnectionCode,
    DisconnectionReason,
} from './AbstractWsEndpoint'
import { Logger } from "@streamr/utils"

export const HIGH_BACK_PRESSURE = 1024 * 1024 * 2
export const LOW_BACK_PRESSURE = 1024 * 1024

export type ReadyState = 0 | 1 | 2 | 3

export abstract class AbstractWsConnection {
    private readonly peerInfo: PeerInfo
    private readonly logger: Logger
    private respondedPong = true
    private rtt?: number
    private rttStart?: number
    private highBackPressure = false
    private onLowBackPressure?: () => void
    private onHighBackPressure?: () => void

    protected constructor(peerInfo: PeerInfo) {
        this.peerInfo = peerInfo
        this.logger = new Logger(module, { peerId: peerInfo.peerId })
    }

    setBackPressureHandlers(onLowBackPressure: () => void, onHighBackPressure: () => void): void | never {
        if (this.onLowBackPressure === undefined && this.onHighBackPressure === undefined) {
            this.onLowBackPressure = onLowBackPressure
            this.onHighBackPressure = onHighBackPressure
        } else {
            throw new Error('invariant: cannot re-set backpressure handlers')
        }
    }

    ping(): void {
        this.respondedPong = false
        this.rttStart = Date.now()
        this.sendPing()
    }

    onPong(): void {
        this.respondedPong = true
        this.rtt = Date.now() - this.rttStart!
    }

    evaluateBackPressure(): void {
        const bufferedAmount = this.getBufferedAmount()
        if (!this.highBackPressure && bufferedAmount > HIGH_BACK_PRESSURE) {
            this.logger.debug('Encountered high back pressure', {
                peerId: this.getPeerInfo().peerId, bufferedAmount
            })
            this.highBackPressure = true
            if (this.onHighBackPressure === undefined) {
                throw new Error('onHighBackPressure listener not set')
            }
            this.onHighBackPressure()
        } else if (this.highBackPressure && bufferedAmount < LOW_BACK_PRESSURE) {
            this.logger.debug('Encountered low back pressure', {
                peerId: this.getPeerInfo().peerId, bufferedAmount
            })
            this.highBackPressure = false
            if (this.onLowBackPressure === undefined) {
                throw new Error('onLowBackPressure listener not set')
            }
            this.onLowBackPressure()
        }
    }

    getPeerInfo(): PeerInfo {
        return this.peerInfo
    }

    getRespondedPong(): boolean {
        return this.respondedPong
    }

    getRtt(): number | undefined {
        return this.rtt
    }

    getPeerId(): PeerId {
        return this.getPeerInfo().peerId
    }

    getDiagnosticInfo(): Record<string, unknown> {
        const getHumanReadableReadyState = (n: number): string => {
            switch (n) {
                case 0: return 'connecting'
                case 1: return 'open'
                case 2: return 'closing'
                case 3: return 'closed'
                default: return `unknown (${n})`
            }
        }
        return {
            peerId: this.getPeerId(),
            rtt: this.getRtt(),
            respondedPong: this.getRespondedPong(),
            readyState: getHumanReadableReadyState(this.getReadyState()),
            bufferedAmount: this.getBufferedAmount(),
            highBackPressure: this.highBackPressure,
        }
    }

    abstract sendPing(): void
    abstract getBufferedAmount(): number
    abstract send(message: string): Promise<void>
    abstract terminate(): void
    abstract getReadyState(): ReadyState
    abstract close(code: DisconnectionCode, reason: DisconnectionReason): void
}
