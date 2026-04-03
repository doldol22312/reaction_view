/*
 * Vencord userplugin: ReactionView
 * Sorts messages in the current channel/thread by total reactions inside a selected time window.
 */

import { definePluginSettings } from "@api/Settings";
import { copyWithToast } from "@utils/discord";
import { sleep } from "@utils/misc";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { Button, Constants, Forms, Menu, MessageActions, RestAPI, showToast, Text, TextInput, Toasts, useEffect, useRef, useState } from "@webpack/common";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";

const DAY = 86_400_000;
const DEFAULT_DAYS = 7;
const CANCELLED_SCAN = "Reaction scan cancelled";

const settings = definePluginSettings({
    maxPages: {
        type: OptionType.NUMBER,
        description: "Maximum 100-message pages to scan per request",
        default: 50
    },
    maxResults: {
        type: OptionType.NUMBER,
        description: "Maximum ranked messages to show in the modal",
        default: 15
    },
    requestDelayMs: {
        type: OptionType.NUMBER,
        description: "Delay between history requests in ms",
        default: 250
    }
});

const AUTHOR = {
    name: "cones",
    id: 0n
};

interface RawAuthor {
    id: string;
    username: string;
    global_name?: string | null;
}

interface RawReactionEmoji {
    id?: string;
    name?: string | null;
}

interface RawReaction {
    count?: number;
    emoji?: RawReactionEmoji | null;
}

interface RawAttachment {
    filename?: string;
}

interface RawMessage {
    id: string;
    channel_id: string;
    content?: string;
    timestamp: string;
    author: RawAuthor;
    reactions?: RawReaction[];
    attachments?: RawAttachment[];
    embeds?: unknown[];
    sticker_items?: unknown[];
}

interface RankedMessage {
    message: RawMessage;
    totalReactions: number;
}

interface ScanProgress {
    pages: number;
    scanned: number;
    matches: number;
}

interface ScanResult {
    results: RankedMessage[];
    truncated: boolean;
}

interface CancelToken {
    cancelled: boolean;
}

const resultCardStyle = {
    border: "1px solid var(--border-subtle)",
    borderRadius: 8,
    padding: 12,
    background: "var(--background-secondary)"
} as const;

const controlRowStyle = {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center"
} as const;

function clampNumber(value: number, fallback: number, min: number, max: number) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}

function getMaxPages() {
    return clampNumber(settings.store.maxPages, 50, 1, 200);
}

function getMaxResults() {
    return clampNumber(settings.store.maxResults, 15, 1, 100);
}

function getRequestDelay() {
    return clampNumber(settings.store.requestDelayMs, 250, 0, 2_000);
}

function getChannelLabel(channel: Channel) {
    return channel.name ? `#${channel.name}` : "this conversation";
}

function getMessageReactionTotal(message: RawMessage) {
    return (message.reactions ?? []).reduce((sum, reaction) => sum + Math.max(0, reaction.count ?? 0), 0);
}

function compareRankedMessages(a: RankedMessage, b: RankedMessage) {
    if (b.totalReactions !== a.totalReactions) {
        return b.totalReactions - a.totalReactions;
    }

    return Date.parse(b.message.timestamp) - Date.parse(a.message.timestamp);
}

function formatEmoji(emoji?: RawReactionEmoji | null) {
    if (!emoji?.name) return "emoji";
    if (!emoji.id) return emoji.name;
    return `:${emoji.name}:`;
}

function getReactionSummary(message: RawMessage) {
    const sorted = [...(message.reactions ?? [])]
        .filter(reaction => (reaction.count ?? 0) > 0)
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
        .slice(0, 8);

    if (!sorted.length) return "No reactions";

    return sorted
        .map(reaction => `${formatEmoji(reaction.emoji)} ${reaction.count ?? 0}`)
        .join(" • ");
}

function getMessagePreview(message: RawMessage) {
    const trimmed = message.content?.trim();
    if (trimmed) {
        const singleLine = trimmed.replace(/\s+/g, " ");
        return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
    }

    const attachmentCount = message.attachments?.length ?? 0;
    const embedCount = message.embeds?.length ?? 0;
    const stickerCount = message.sticker_items?.length ?? 0;
    const parts: string[] = [];

    if (attachmentCount) parts.push(`${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`);
    if (embedCount) parts.push(`${embedCount} embed${embedCount === 1 ? "" : "s"}`);
    if (stickerCount) parts.push(`${stickerCount} sticker${stickerCount === 1 ? "" : "s"}`);

    return parts.length ? `[${parts.join(", ")}]` : "[No text content]";
}

function getAuthorLabel(author: RawAuthor) {
    return author.global_name || author.username || "Unknown user";
}

function formatTimestamp(timestamp: string) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.valueOf())) return timestamp;
    return date.toLocaleString();
}

function buildMessageLink(channel: Channel, messageId: string) {
    return `https://discord.com/channels/${channel.guild_id ?? "@me"}/${channel.id}/${messageId}`;
}

function jumpToMessage(channelId: string, messageId: string) {
    MessageActions.jumpToMessage({
        channelId,
        messageId,
        flash: true,
        jumpType: "INSTANT"
    });
}

async function fetchMessagesPage(channelId: string, before?: string) {
    const response = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: {
            limit: 100,
            ...(before ? { before } : {})
        },
        retries: 2
    });

    return (response?.body ?? []) as RawMessage[];
}

async function scanChannelByReactions(
    channelId: string,
    minTimestamp: number,
    token: CancelToken,
    onProgress: (progress: ScanProgress) => void
): Promise<ScanResult> {
    const ranked: RankedMessage[] = [];
    const maxPages = getMaxPages();
    const delay = getRequestDelay();

    let before: string | undefined;
    let pages = 0;
    let scanned = 0;
    let matches = 0;
    let hitBoundary = false;
    let exhaustedHistory = false;

    while (pages < maxPages) {
        if (token.cancelled) throw new Error(CANCELLED_SCAN);

        const messages = await fetchMessagesPage(channelId, before);
        pages += 1;

        if (!messages.length) {
            exhaustedHistory = true;
            onProgress({ pages, scanned, matches });
            break;
        }

        scanned += messages.length;

        for (const message of messages) {
            const timestamp = Date.parse(message.timestamp);
            if (!Number.isFinite(timestamp)) continue;

            if (timestamp < minTimestamp) {
                hitBoundary = true;
                break;
            }

            const totalReactions = getMessageReactionTotal(message);
            if (totalReactions < 1) continue;

            ranked.push({ message, totalReactions });
            matches += 1;
        }

        onProgress({ pages, scanned, matches });

        if (hitBoundary) break;

        before = messages[messages.length - 1]?.id;
        if (!before) {
            exhaustedHistory = true;
            break;
        }

        if (messages.length < 100) {
            exhaustedHistory = true;
            break;
        }

        if (delay > 0) {
            await sleep(delay);
        }
    }

    ranked.sort(compareRankedMessages);

    return {
        results: ranked,
        truncated: !hitBoundary && !exhaustedHistory && pages >= maxPages
    };
}

function ReactionViewModal({ channel, modalProps }: { channel: Channel; modalProps: ModalProps; }) {
    const [customDays, setCustomDays] = useState("14");
    const [activeDays, setActiveDays] = useState(DEFAULT_DAYS);
    const [results, setResults] = useState<RankedMessage[]>([]);
    const [progress, setProgress] = useState<ScanProgress>({ pages: 0, scanned: 0, matches: 0 });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [truncated, setTruncated] = useState(false);
    const tokenRef = useRef<CancelToken | null>(null);

    const maxResults = getMaxResults();
    const maxPages = getMaxPages();
    const channelLabel = getChannelLabel(channel);

    async function startScan(days: number) {
        const safeDays = clampNumber(days, DEFAULT_DAYS, 1, 365);
        const minTimestamp = Date.now() - safeDays * DAY;
        const token = { cancelled: false };

        if (tokenRef.current) {
            tokenRef.current.cancelled = true;
        }
        tokenRef.current = token;

        setActiveDays(safeDays);
        setLoading(true);
        setError(null);
        setTruncated(false);
        setResults([]);
        setProgress({ pages: 0, scanned: 0, matches: 0 });

        try {
            const scan = await scanChannelByReactions(channel.id, minTimestamp, token, setProgress);
            if (token.cancelled) return;

            setResults(scan.results.slice(0, maxResults));
            setTruncated(scan.truncated);
        } catch (error) {
            if (token.cancelled) return;

            const message = error instanceof Error ? error.message : String(error);
            if (message !== CANCELLED_SCAN) {
                setError(message);
            }
        } finally {
            if (tokenRef.current === token) {
                setLoading(false);
            }
        }
    }

    function handleCustomScan() {
        const parsed = Number(customDays);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            showToast("Enter a positive number of days.", Toasts.Type.FAILURE);
            return;
        }

        void startScan(parsed);
    }

    useEffect(() => {
        void startScan(DEFAULT_DAYS);

        return () => {
            if (tokenRef.current) {
                tokenRef.current.cancelled = true;
            }
        };
    }, [channel.id]);

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>Top Reacted Messages</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent>
                <div style={{ display: "grid", gap: 16 }}>
                    <section>
                        <Forms.FormTitle tag="h5">Scope</Forms.FormTitle>
                        <Forms.FormText>
                            Scans {channelLabel} and ranks messages by total reactions in the last {activeDays} day{activeDays === 1 ? "" : "s"}.
                        </Forms.FormText>
                        <Forms.FormText>
                            Each scan is capped at {maxPages * 100} messages to avoid excessive API churn.
                        </Forms.FormText>
                    </section>

                    <section>
                        <Forms.FormTitle tag="h5">Time Window</Forms.FormTitle>
                        <div style={controlRowStyle}>
                            <Button onClick={() => void startScan(1)} disabled={loading && activeDays === 1}>Day</Button>
                            <Button onClick={() => void startScan(7)} disabled={loading && activeDays === 7}>Week</Button>
                            <Button onClick={() => void startScan(30)} disabled={loading && activeDays === 30}>Month</Button>
                            <TextInput
                                value={customDays}
                                onChange={setCustomDays}
                                placeholder="Days"
                                inputMode="numeric"
                                style={{ width: 96 }}
                            />
                            <Button onClick={handleCustomScan} disabled={loading}>Scan custom days</Button>
                        </div>
                    </section>

                    <section>
                        <Forms.FormTitle tag="h5">Scan Status</Forms.FormTitle>
                        <Forms.FormText>
                            {loading
                                ? `Scanning... ${progress.scanned} messages across ${progress.pages} page${progress.pages === 1 ? "" : "s"}.`
                                : `Scanned ${progress.scanned} messages across ${progress.pages} page${progress.pages === 1 ? "" : "s"} and found ${progress.matches} reacted message${progress.matches === 1 ? "" : "s"}.`}
                        </Forms.FormText>
                        {truncated && (
                            <Forms.FormText style={{ color: "var(--status-warning)" }}>
                                Scan limit reached before the full time window was exhausted. Increase the plugin page limit if you need deeper history.
                            </Forms.FormText>
                        )}
                        {error && (
                            <Forms.FormText style={{ color: "var(--text-feedback-critical)" }}>
                                {error}
                            </Forms.FormText>
                        )}
                    </section>

                    <section style={{ display: "grid", gap: 12 }}>
                        <Forms.FormTitle tag="h5">Ranking</Forms.FormTitle>

                        {!loading && !results.length && !error && (
                            <Forms.FormText>No reacted messages were found in this window.</Forms.FormText>
                        )}

                        {results.map((entry, index) => {
                            const { message } = entry;
                            const link = buildMessageLink(channel, message.id);

                            return (
                                <div key={message.id} style={resultCardStyle}>
                                    <div style={{ ...controlRowStyle, justifyContent: "space-between" }}>
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <Text variant="heading-md/semibold">
                                                #{index + 1} • {entry.totalReactions} reaction{entry.totalReactions === 1 ? "" : "s"}
                                            </Text>
                                            <Forms.FormText>
                                                {getAuthorLabel(message.author)} • {formatTimestamp(message.timestamp)}
                                            </Forms.FormText>
                                        </div>

                                        <div style={controlRowStyle}>
                                            <Button
                                                onClick={() => copyWithToast(link, "Message link copied to clipboard!")}
                                            >
                                                Copy Link
                                            </Button>
                                            <Button
                                                onClick={() => {
                                                    modalProps.onClose();
                                                    jumpToMessage(channel.id, message.id);
                                                }}
                                            >
                                                Jump
                                            </Button>
                                        </div>
                                    </div>

                                    <div style={{ marginTop: 8 }}>
                                        <Text variant="text-md/normal">{getMessagePreview(message)}</Text>
                                    </div>

                                    <div style={{ marginTop: 8 }}>
                                        <Forms.FormText>{getReactionSummary(message)}</Forms.FormText>
                                    </div>
                                </div>
                            );
                        })}
                    </section>
                </div>
            </ModalContent>

            <ModalFooter>
                <Button onClick={() => void startScan(activeDays)} disabled={loading}>Refresh</Button>
                <Button onClick={modalProps.onClose}>Close</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

function openReactionView(channel: Channel) {
    openModal(modalProps => <ReactionViewModal channel={channel} modalProps={modalProps} />);
}

function addContextItem(children: Array<any>, channel?: Channel | null) {
    if (!channel) return;

    children.push(
        <Menu.MenuGroup id="vc-reaction-view">
            <Menu.MenuItem
                id="vc-reaction-view-open"
                label="Top Reacted Messages"
                icon={ChartIcon}
                action={() => openReactionView(channel)}
            />
        </Menu.MenuGroup>
    );
}

const ChartIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        width={width}
        height={height}
        className={className}
    >
        <path d="M5 3a1 1 0 0 1 1 1v14h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm4 8a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0v-3a1 1 0 0 1 1-1Zm5-4a1 1 0 0 1 1 1v7a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm5-3a1 1 0 0 1 1 1v10a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1Z" />
    </svg>
);

export default definePlugin({
    name: "ReactionView",
    description: "Ranks the most reacted messages in the current channel for day, week, month, or custom day windows",
    authors: [AUTHOR],
    settings,
    requiresRestart: false,
    tags: ["reactions", "ranking", "statistics"],
    contextMenus: {
        "channel-context": (children, { channel }) => addContextItem(children, channel),
        "thread-context": (children, { channel }) => addContextItem(children, channel),
        "gdm-context": (children, { channel }) => addContextItem(children, channel)
    }
});
