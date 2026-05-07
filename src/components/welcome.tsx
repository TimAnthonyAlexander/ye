import { Box, Text } from "ink";
import { memo } from "react";

interface WelcomeProps {
    readonly version: string;
    readonly cwd: string;
    readonly providerId: string;
    readonly model: string;
    readonly username: string | null;
}

export const Welcome = memo(({ version, cwd, providerId, model, username }: WelcomeProps) => {
    const greeting = username ? `Welcome back, ${username}!` : "Welcome to Ye!";
    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="gray"
            paddingX={2}
            paddingY={1}
            marginBottom={1}
        >
            <Text bold>
                <Text color="cyan">▐▛███▜▌</Text> Ye v{version}
            </Text>
            <Box marginTop={1} flexDirection="column">
                <Text>{greeting}</Text>
                <Text dimColor>
                    {providerId} · {model}
                </Text>
                <Text dimColor>{cwd}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text dimColor>
                    Tip: this project hasn&apos;t been initialized — run{" "}
                    <Text bold color="white">
                        /init
                    </Text>
                    <Text dimColor> to create a YE.md file.</Text>
                </Text>
            </Box>
        </Box>
    );
});
Welcome.displayName = "Welcome";
