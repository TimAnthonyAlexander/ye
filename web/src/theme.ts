import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
    palette: {
        background: {
            default: "#FFFFFF",
            paper: "#FFFFFF",
        },
    },
    typography: {
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        h1: { fontFamily: '"DM Serif Display", serif' },
        h2: { fontFamily: '"DM Serif Display", serif' },
        h3: { fontFamily: '"DM Serif Display", serif' },
        h4: { fontFamily: '"DM Serif Display", serif' },
        h5: { fontFamily: '"DM Serif Display", serif' },
        h6: { fontFamily: '"DM Serif Display", serif' },
    },
});
