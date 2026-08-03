import { Box, Text, useInput } from "ink";
import type { InstallOffer } from "../lsp/install/index.ts";

interface LspOfferProps {
    readonly offer: InstallOffer;
    readonly onOpen: () => void;
}

// Ctrl+L is the only key this claims, and the input keeps every other one, so
// ignoring the banner and typing works — and is not an answer.
export const LspOffer = ({ offer, onOpen }: LspOfferProps) => {
    useInput((input, key) => {
        if (key.ctrl && input === "l") onOpen();
    });

    return (
        <Box flexDirection="column" marginBottom={1} paddingX={1}>
            <Text>
                No language server found for <Text bold>{offer.displayName}</Text>.
            </Text>
            <Text dimColor>{offer.note}</Text>
            <Text dimColor>{offer.command}</Text>
            <Text dimColor>
                <Text color="cyan">ctrl+l</Text> to install, decline or dismiss · or ignore this and
                keep typing
            </Text>
        </Box>
    );
};
