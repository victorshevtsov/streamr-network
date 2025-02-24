import KBucket from 'k-bucket'
import { PeerID, PeerIDKey } from '../helpers/PeerID'

class ContactState<Contact> {

    public contact: Contact
    public contacted = false
    public active = false

    constructor(contact: Contact) {
        this.contact = contact
    }
}

interface IContact { peerId: PeerID }

export class SortedContactList<Contact extends IContact> {

    private contactsById: Map<PeerIDKey, ContactState<Contact>> = new Map()
    private contactIds: PeerID[] = []
    private ownId: PeerID
    private maxSize: number

    constructor(ownId: PeerID, maxSize: number) {
        this.compareIds = this.compareIds.bind(this)
        this.ownId = ownId
        this.maxSize = maxSize
    }

    public getClosestContactId(): PeerID {
        return this.contactIds[0]
    }

    public getContactIds(): PeerID[] {
        return this.contactIds
    }

    public addContact(contact: Contact): void {
        if (this.ownId.equals(contact.peerId)) {
            return
        }
        if (!this.contactsById.has(contact.peerId.toKey())) {
            if (this.contactIds.length < this.maxSize) {
                this.contactsById.set(contact.peerId.toKey(), new ContactState(contact))
                this.contactIds.push(contact.peerId)
                this.contactIds.sort(this.compareIds)
            
            } else if (this.compareIds(this.contactIds[this.maxSize - 1], contact.peerId) > 0) {
                const removed = this.contactIds.pop()
                this.contactsById.delete(removed!.toKey())
                this.contactsById.set(contact.peerId.toKey(), new ContactState(contact))
                this.contactIds.push(contact.peerId)
                this.contactIds.sort(this.compareIds)
            }
        }  
    }

    public addContacts(contacts: Contact[]): void {
        contacts.forEach( (contact) => this.addContact(contact))
    }

    public setContacted(contactId: PeerID): void {
        if (this.contactsById.has(contactId.toKey())) {
            this.contactsById.get(contactId.toKey())!.contacted = true
        }
    }

    public setActive(contactId: PeerID): void {
        if (this.contactsById.has(contactId.toKey())) {
            this.contactsById.get(contactId.toKey())!.active = true
        }
    }

    public getUncontactedContacts(num: number): Contact[] {
        const ret: Contact[] = []
        for (const contactId of this.contactIds) {
            if (this.contactsById.has(contactId.toKey()) && !this.contactsById.get(contactId.toKey())!.contacted) {
                ret.push(this.contactsById.get(contactId.toKey())!.contact)
                if (ret.length >= num) {
                    return ret
                }
            }
        }
        return ret
    }

    public getActiveContacts(): Contact[] {
        const ret: Contact[] = []
        this.contactIds.forEach((contactId) => {
            if (this.isActive(contactId)) {
                ret.push(this.contactsById.get(contactId.toKey())!.contact)
            }
        })
        return ret
    }

    public compareIds(id1: PeerID, id2: PeerID): number {
        const distance1 = KBucket.distance(this.ownId.value, id1.value)
        const distance2 = KBucket.distance(this.ownId.value, id2.value)
        return distance1 - distance2
    }

    public getStringIds(): string[] {
        return this.contactIds.map((peerId) => peerId.toKey())
    }

    public getSize(): number {
        return this.contactIds.length
    }

    public getContact(id: PeerID): ContactState<Contact> {
        return this.contactsById.get(id.toKey())!
    }

    public removeContact(id: PeerID): boolean {
        if (this.contactsById.has(id.toKey())) {
            const index = this.contactIds.indexOf(id)
            this.contactIds.splice(index, 1)
            this.contactsById.delete(id.toKey())
            return true
        }
        return false
    }

    public hasContact(id: PeerID): boolean {
        return this.contactsById.has(id.toKey())
    }

    public isActive(id: PeerID): boolean {
        return this.contactsById.has(id.toKey()) ? this.contactsById.get(id.toKey())!.active : false
    }

    public getAllContacts(): Contact[] {
        return [...this.contactsById.values()].map((contact) => contact.contact)
    }

    public getMaxSize(): number {
        return this.maxSize
    }
}
