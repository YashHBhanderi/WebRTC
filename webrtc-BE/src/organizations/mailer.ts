/**
 * Invitation delivery. SpreeWe has no email provider yet (owner decision, 2026-10-26): invitations are
 * secure links the inviter copies, and invitees also see them in-app after signing in with the invited
 * (verified) address. Plug a provider in by registering a sender; nothing else changes.
 */
export interface InvitationEmail {
    to: string;
    organizationName: string;
    inviterName: string;
    role: string;
    link: string;
    expiresAt: Date;
}

export interface InvitationSender {
    readonly name: string;
    send(email: InvitationEmail): Promise<void>;
}

let sender: InvitationSender | null = null;

export function setInvitationSender(s: InvitationSender | null): void {
    sender = s;
}

/** true when an email was handed to a provider; false when the link must be shared by hand. */
export async function deliverInvitation(email: InvitationEmail): Promise<boolean> {
    if (!sender) return false;
    try {
        await sender.send(email);
        return true;
    } catch {
        // Delivery failure never fails the invitation: the inviter still gets the link
        return false;
    }
}
