import { describe, expect, it } from 'vitest';
import {
    buildWhatsAppInboundMessage,
    normalizeWhatsAppChannelRef,
    rememberProcessedWhatsAppMessage,
    resolveWhatsAppSendTarget,
} from './whatsapp';

describe('channels/whatsapp', () => {
    it('builds a direct inbound envelope from a plain text message', () => {
        const inbound = buildWhatsAppInboundMessage({
            message: {
                key: {
                    id: 'wamid-1',
                    remoteJid: '393331234567@s.whatsapp.net',
                    fromMe: false,
                },
                pushName: 'Alice',
                message: {
                    conversation: 'Привет из WhatsApp',
                },
            } as any,
            botUserId: '+390000000000',
        });

        expect(inbound).toEqual(
            expect.objectContaining({
                channel: 'whatsapp',
                channelRef: '+393331234567',
                senderId: '+393331234567',
                senderDisplayName: 'Alice',
                messageId: 'wamid-1',
                text: 'Привет из WhatsApp',
                isDirect: true,
                isPrimaryGroup: false,
                botUserId: '+390000000000',
            })
        );
    });

    it('builds a primary-group inbound envelope with quoted reply context', () => {
        const inbound = buildWhatsAppInboundMessage({
            message: {
                key: {
                    id: 'wamid-2',
                    remoteJid: '120363022222222222@g.us',
                    participant: '393339999999@s.whatsapp.net',
                    fromMe: false,
                },
                pushName: 'Bob',
                message: {
                    extendedTextMessage: {
                        text: 'Pipi help me with this',
                        contextInfo: {
                            participant: '393330000000@s.whatsapp.net',
                            quotedMessage: {
                                conversation: 'Earlier bot reply',
                            },
                        },
                    },
                },
            } as any,
            primaryGroupJid: '120363022222222222@g.us',
            botUserId: '+393330000000',
        });

        expect(inbound).toEqual(
            expect.objectContaining({
                channelRef: '120363022222222222@g.us',
                senderId: '+393339999999',
                senderDisplayName: 'Bob',
                text: 'Pipi help me with this',
                isDirect: false,
                isPrimaryGroup: true,
                botUserId: '+393330000000',
                replyTo: {
                    senderId: '+393330000000',
                    senderDisplayName: '+393330000000',
                    text: 'Earlier bot reply',
                },
            })
        );
    });

    it('ignores non-primary WhatsApp groups', () => {
        const inbound = buildWhatsAppInboundMessage({
            message: {
                key: {
                    id: 'wamid-3',
                    remoteJid: '120363099999999999@g.us',
                    participant: '393339999999@s.whatsapp.net',
                    fromMe: false,
                },
                message: {
                    conversation: 'hello',
                },
            } as any,
            primaryGroupJid: '120363022222222222@g.us',
        });

        expect(inbound).toBeNull();
    });

    it('normalizes outbound targets for direct chats and preserves group JIDs', () => {
        expect(resolveWhatsAppSendTarget('+39 333 123 4567')).toBe('393331234567@s.whatsapp.net');
        expect(resolveWhatsAppSendTarget('120363022222222222@g.us')).toBe('120363022222222222@g.us');
        expect(normalizeWhatsAppChannelRef('393331234567@s.whatsapp.net')).toBe('+393331234567');
        expect(normalizeWhatsAppChannelRef('120363022222222222@g.us')).toBe('120363022222222222@g.us');
    });

    it('deduplicates already seen WhatsApp message ids', () => {
        const processed = new Map<string, number>();

        expect(rememberProcessedWhatsAppMessage(processed, 'wamid-4', 1_000)).toBe(true);
        expect(rememberProcessedWhatsAppMessage(processed, 'wamid-4', 2_000)).toBe(false);
        expect(rememberProcessedWhatsAppMessage(processed, 'wamid-5', 3_000)).toBe(true);
    });
});
