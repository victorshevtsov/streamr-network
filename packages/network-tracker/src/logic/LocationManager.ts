import { lookup, Lookup } from 'geoip-lite'
import { Location, NodeId } from '@streamr/network-node'

function isValidNodeLocation(location?: Location) {
    return (location !== undefined) && (location.country || location.city || location.latitude || location.longitude)
}

export class LocationManager {
    private readonly nodeLocations: Record<NodeId, Location>

    constructor() {
        this.nodeLocations = {}
    }

    getAllNodeLocations(): Readonly<Record<NodeId, Location>> {
        return this.nodeLocations
    }

    getNodeLocation(nodeId: NodeId): Location {
        return this.nodeLocations[nodeId]
    }

    updateLocation({ nodeId, location, address }: { nodeId: NodeId, location?: Location, address?: string }): void {
        if (isValidNodeLocation(location)) {
            this.nodeLocations[nodeId] = location!
        } else if (!isValidNodeLocation(this.nodeLocations[nodeId])) {
            let geoIpRecord: null | Lookup = null
            if (address) {
                geoIpRecord = lookup(address)
            }

            if (geoIpRecord) {
                this.nodeLocations[nodeId] = {
                    country: geoIpRecord.country,
                    city: geoIpRecord.city,
                    latitude: geoIpRecord.ll[0],
                    longitude: geoIpRecord.ll[1]
                }
            }
        }
    }

    removeNode(nodeId: NodeId): void {
        delete this.nodeLocations[nodeId]
    }
}
