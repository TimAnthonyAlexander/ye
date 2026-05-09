import { Box, Text } from "ink";
import { memo } from "react";
import { BANNER_LINES } from "./homeBanner.tsx";

interface ChatBannerProps {
    readonly version: string;
}

export const ChatBanner = memo(({ version }: ChatBannerProps) => {
    return (
        <Box flexDirection="column" marginBottom={1}>
            {BANNER_LINES.map((line, i) => (
                <Text key={i} color="cyan" bold>
                    {line}
                </Text>
            ))}
            <Text dimColor>Ye v{version}</Text>
        </Box>
    );
});
ChatBanner.displayName = "ChatBanner";
