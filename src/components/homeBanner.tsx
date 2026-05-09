import { Box, Text } from "ink";
import { memo } from "react";

export const BANNER_LINES: readonly string[] = ["▙   ▟  ▛▀▀", " ▜▄▛   ▙▄▖", "  █    ▙▄▄"];

interface HomeBannerProps {
    readonly version: string;
}

export const HomeBanner = memo(({ version }: HomeBannerProps) => {
    return (
        <Box flexDirection="column" alignItems="center">
            {BANNER_LINES.map((line, i) => (
                <Text key={i} color="cyan" bold>
                    {line}
                </Text>
            ))}
            <Box marginTop={1}>
                <Text dimColor>Ye v{version}</Text>
            </Box>
        </Box>
    );
});
HomeBanner.displayName = "HomeBanner";
