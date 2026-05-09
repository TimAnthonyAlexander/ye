import { useState, useRef, type ReactNode } from 'react';
import {
  Box,
  Typography,
  Button,
  Container,
  Stack,
  Chip,
  Link as MuiLink,
} from '@mui/material';
import {
  Terminal,
  Layers,
  Search,
  Puzzle,
  Zap,
  Globe,
  Code2,
  Workflow,
  Shield,
  ArrowRight,
  Copy,
  Check,
  BookOpen,
  Download,
} from 'lucide-react';

function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const accent = '#C85A3F';

function CodeBlock(props: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <Box
      ref={ref}
      sx={{
        position: 'relative',
        bgcolor: '#0D0D0D',
        color: '#E6E6E6',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: '0.875rem',
        px: 3,
        py: 2,
        borderRadius: 1,
        overflow: 'auto',
        border: '1px solid #2A2A2A',
      }}
    >
      <Box
        component="button"
        onClick={() => {
          navigator.clipboard.writeText(ref.current?.textContent ?? '');
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        sx={{
          position: 'absolute',
          top: 10,
          right: 10,
          bgcolor: '#1A1A1A',
          color: '#999',
          border: 'none',
          borderRadius: 0.5,
          p: 0.75,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          fontSize: '0.75rem',
          '&:hover': { color: '#FFF' },
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? 'Copied' : 'Copy'}
      </Box>
      <Typography component="span" sx={{ color: '#888', userSelect: 'none' }}>
        ${' '}
      </Typography>
      {props.children}
    </Box>
  );
}

const features = [
  {
    icon: Layers,
    label: 'Subagents',
    body: 'Isolated agents for search, general tasks, and post-change verification. Full history never pollutes parent context.',
  },
  {
    icon: Workflow,
    label: 'Plan mode',
    body: 'Shift+Tab into read-only planning. Propose a plan, get approval, execute. Plans persist for reuse.',
  },
  {
    icon: Globe,
    label: 'Web search',
    body: 'Search the web and fetch pages — Ye reads docs, release notes, and APIs so you stay in the terminal.',
  },
  {
    icon: Puzzle,
    label: 'Skills',
    body: 'Portable SKILL.md recipes from GitHub marketplaces. Domain knowledge without the per-turn token cost.',
  },
  {
    icon: Zap,
    label: 'Smart compaction',
    body: 'Five-shapers chain — Budget Reduction to Auto-Compact — keeps context lean without losing what matters.',
  },
  {
    icon: Search,
    label: 'Auto-memory',
    body: 'LLM-selected memory files. No embeddings, no vector DB — plain Markdown you can inspect and version.',
  },
];

const tools = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Task',
  'Skill',
  'TodoWrite',
  'SaveMemory',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
];

const providers = ['OpenRouter', 'Anthropic', 'OpenAI'];

const installs = [
  {
    label: 'macOS',
    command:
      'curl -fsSL https://github.com/TimAnthonyAlexander/ye/releases/latest/download/ye-macos -o ye && chmod +x ye && sudo mv ye /usr/local/bin/ye',
  },
  {
    label: 'Linux',
    command:
      'curl -fsSL https://github.com/TimAnthonyAlexander/ye/releases/latest/download/ye-linux -o ye && chmod +x ye && sudo mv ye /usr/local/bin/ye',
  },
  {
    label: 'Windows',
    command:
      '$dest = "$env:LOCALAPPDATA\\Programs\\ye"; New-Item -ItemType Directory -Force $dest | Out-Null; Invoke-WebRequest https://github.com/TimAnthonyAlexander/ye/releases/latest/download/ye-windows.exe -OutFile "$dest\\ye.exe"; [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$dest", "User")',
  },
];

export default function Landing() {
  const [activeInstall, setActiveInstall] = useState(0);

  return (
    <Box sx={{ minHeight: '100vh' }}>
      <Box
        component="header"
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          px: 4,
          py: 2.5,
          borderBottom: '1px solid #EBEBEB',
        }}
      >
        <Box
          component="img"
          src="/img/ye-logo-light.svg"
          alt="Ye"
          sx={{ height: 32 }}
        />
        <Stack direction="row" spacing={2} alignItems="center">
          <Button
            href="https://github.com/TimAnthonyAlexander/ye"
            target="_blank"
            sx={{
              color: '#444',
              textTransform: 'none',
              fontSize: '0.875rem',
              fontWeight: 400,
              '&:hover': { color: '#000', bgcolor: 'transparent' },
            }}
          >
            GitHub
          </Button>
          <Button
            href="https://github.com/TimAnthonyAlexander/ye/blob/main/docs/OVERVIEW.md"
            target="_blank"
            sx={{
              color: '#444',
              textTransform: 'none',
              fontSize: '0.875rem',
              fontWeight: 400,
              '&:hover': { color: '#000', bgcolor: 'transparent' },
            }}
          >
            Docs
          </Button>
        </Stack>
      </Box>

      <Container maxWidth="lg">
        <Box sx={{ pt: 12, pb: 8, textAlign: 'center' }}>
          <Box
            component="img"
            src="/img/ye-logo-light.svg"
            alt="Ye"
            sx={{ width: 140, mx: 'auto', mb: 4, display: 'block' }}
          />
          <Chip
            label="v2.0.0"
            size="small"
            sx={{
              mb: 3,
              bgcolor: '#FFF5F3',
              color: accent,
              fontWeight: 600,
              fontSize: '0.75rem',
              borderRadius: 1,
              border: `1px solid ${accent}30`,
            }}
          />
          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: '2.75rem', md: '4rem' },
              fontWeight: 400,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              mb: 2.5,
            }}
          >
            The coding agent.
            <br />
            Open source.
          </Typography>
          <Typography
            sx={{
              fontSize: '1.125rem',
              color: '#666',
              maxWidth: 480,
              mx: 'auto',
              mb: 5,
              lineHeight: 1.6,
            }}
          >
            Subagents, planning, web search, skills, hooks —{' '}
            Ye lives in your terminal and stays out of your way.
          </Typography>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            justifyContent="center"
            mb={6}
          >
            <Button
              href="https://github.com/TimAnthonyAlexander/ye"
              target="_blank"
              variant="contained"
              endIcon={<ArrowRight size={18} />}
              sx={{
                bgcolor: '#0D0D0D',
                color: '#FFF',
                textTransform: 'none',
                fontWeight: 600,
                fontSize: '0.938rem',
                px: 3,
                py: 1.25,
                borderRadius: 1,
                boxShadow: 'none',
                '&:hover': { bgcolor: '#222', boxShadow: 'none' },
              }}
            >
              View on GitHub
            </Button>
            <Button
              href="#install"
              variant="outlined"
              endIcon={<Download size={18} />}
              sx={{
                color: '#0D0D0D',
                borderColor: '#D9D9D9',
                textTransform: 'none',
                fontWeight: 600,
                fontSize: '0.938rem',
                px: 3,
                py: 1.25,
                borderRadius: 1,
                '&:hover': { borderColor: '#AAA', bgcolor: '#FAFAFA' },
              }}
            >
              Install
            </Button>
          </Stack>

          <Box sx={{ maxWidth: 620, mx: 'auto' }}>
            <CodeBlock>
              {'curl -fsSL https://github.com/TimAnthonyAlexander/'}
              <Typography component="span" sx={{ color: accent }}>
                {'ye/releases/latest/download/ye-macos'}
              </Typography>
              {' -o ye && chmod +x ye && sudo mv ye /usr/local/bin/ye'}
            </CodeBlock>
          </Box>
        </Box>

        <Box sx={{ py: 10 }}>
          <Typography
            variant="h2"
            sx={{
              fontSize: '2rem',
              fontWeight: 400,
              letterSpacing: '-0.02em',
              mb: 1,
              textAlign: 'center',
            }}
          >
            See it in action
          </Typography>
          <Typography
            sx={{ fontSize: '1rem', color: '#666', textAlign: 'center', mb: 5 }}
          >
            Ye lives in your terminal — here's what that looks like.
          </Typography>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 2.5,
              overflowX: 'auto',
              pb: 1,
              scrollSnapType: 'x mandatory',
              '&::-webkit-scrollbar': { height: 6 },
              '&::-webkit-scrollbar-track': { bgcolor: '#F5F5F5', borderRadius: 3 },
              '&::-webkit-scrollbar-thumb': { bgcolor: '#D9D9D9', borderRadius: 3, '&:hover': { bgcolor: '#BBB' } },
            }}
          >
            {([
              { src: '/img/YE_Home.png', label: 'Home' },
              { src: '/img/YE_Mention.png', label: '@-mention picker' },
              { src: '/img/YE_Editing.png', label: 'Live editing' },
              { src: '/img/YE_Working.png', label: 'Tool calls' },
            ]).map((shot) => (
              <Box
                key={shot.src}
                sx={{
                  flex: '0 0 auto',
                  maxWidth: { xs: '88vw', md: 600 },
                  scrollSnapAlign: 'start',
                  borderRadius: 1.5,
                  overflow: 'hidden',
                  border: '1px solid #E0E0E0',
                  bgcolor: '#FCFCFC',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.75,
                    px: 1.5,
                    py: 1.25,
                    bgcolor: '#F2F2F2',
                    borderBottom: '1px solid #E0E0E0',
                  }}
                >
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#EC6A5E' }} />
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#F5BF4F' }} />
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#61C454' }} />
                  <Typography
                    sx={{
                      fontSize: '0.75rem',
                      color: '#888',
                      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                      ml: 0.5,
                    }}
                  >
                    {shot.label}
                  </Typography>
                </Box>
                <Box
                  component="img"
                  src={shot.src}
                  alt={shot.label}
                  sx={{ width: '100%', height: 'auto', display: 'block' }}
                />
              </Box>
            ))}
          </Box>
        </Box>

        <Box sx={{ py: 10 }}>
          <Typography
            component="p"
            sx={{
              textAlign: 'center',
              fontSize: '0.8125rem',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: '#999',
              mb: 4,
            }}
          >
            Built with
          </Typography>
          <Stack direction="row" spacing={4} justifyContent="center">
            <Stack direction="row" spacing={1} alignItems="center" sx={{ color: '#666' }}>
              <Code2 size={18} />
              <Typography sx={{ fontSize: '0.938rem', fontWeight: 500 }}>
                TypeScript
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ color: '#666' }}>
              <Terminal size={18} />
              <Typography sx={{ fontSize: '0.938rem', fontWeight: 500 }}>
                React · Ink 5
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ color: '#666' }}>
              <Zap size={18} />
              <Typography sx={{ fontSize: '0.938rem', fontWeight: 500 }}>
                Bun
              </Typography>
            </Stack>
          </Stack>
        </Box>

        <Box sx={{ py: 10 }}>
          <Typography
            variant="h2"
            sx={{
              fontSize: '2rem',
              fontWeight: 400,
              letterSpacing: '-0.02em',
              mb: 1,
              textAlign: 'center',
            }}
          >
            Why Ye
          </Typography>
          <Typography
            sx={{
              fontSize: '1rem',
              color: '#666',
              textAlign: 'center',
              mb: 6,
            }}
          >
            Open source from day one. Built on the same agent-loop architecture as
            the closed tools — but you can read the source, extend it, and run it on
            whatever model you want.
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 0,
              borderTop: '1px solid #EBEBEB',
              borderLeft: '1px solid #EBEBEB',
            }}
          >
            {features.map((f) => (
              <Box
                key={f.label}
                sx={{
                  p: 3.5,
                  borderRight: '1px solid #EBEBEB',
                  borderBottom: '1px solid #EBEBEB',
                }}
              >
                <f.icon size={22} color={accent} strokeWidth={1.5} />
                <Typography
                  sx={{
                    fontSize: '1rem',
                    fontWeight: 600,
                    mt: 2,
                    mb: 0.75,
                  }}
                >
                  {f.label}
                </Typography>
                <Typography
                  sx={{
                    fontSize: '0.875rem',
                    color: '#666',
                    lineHeight: 1.6,
                  }}
                >
                  {f.body}
                </Typography>
              </Box>
            ))}
          </Box>

          <Box
            component="img"
            src="/img/YE_Result_Website_Hero.png"
            alt="Full website built by Ye"
            sx={{
              width: '100%',
              mt: 8,
              borderRadius: 1.5,
              border: '1px solid #EBEBEB',
            }}
          />
        </Box>

        <Box sx={{ py: 10 }}>
          <Box sx={{ display: 'flex', gap: 10, flexDirection: { xs: 'column', md: 'row' } }}>
            <Box sx={{ flex: 1 }}>
              <Typography
                sx={{
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#999',
                  mb: 2,
                }}
              >
                Tools
              </Typography>
              <Typography
                variant="h3"
                sx={{
                  fontSize: '1.75rem',
                  fontWeight: 400,
                  letterSpacing: '-0.02em',
                  mb: 2,
                }}
              >
                Fifteen tools.
                <br />
                One terminal.
              </Typography>
              <Typography sx={{ fontSize: '0.938rem', color: '#666', lineHeight: 1.6 }}>
                Read, edit, and write files. Run shell commands. Search the codebase
                and the web. Spawn subagents for heavy lifting. Save memories for
                future sessions. All through a consistent tool interface.
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }}>
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 1,
                }}
              >
                {tools.map((t) => (
                  <Chip
                    key={t}
                    label={t}
                    size="small"
                    sx={{
                      bgcolor: '#F8F8F8',
                      color: '#444',
                      fontWeight: 500,
                      fontSize: '0.8125rem',
                      border: '1px solid #ECECEC',
                      borderRadius: 0.75,
                    }}
                  />
                ))}
              </Box>
            </Box>
          </Box>
        </Box>

        <Box sx={{ py: 10 }}>
          <Box sx={{ display: 'flex', gap: 10, flexDirection: { xs: 'column', md: 'row' } }}>
            <Box sx={{ flex: 1 }}>
              <Typography
                sx={{
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#999',
                  mb: 2,
                }}
              >
                Providers
              </Typography>
              <Typography
                variant="h3"
                sx={{
                  fontSize: '1.75rem',
                  fontWeight: 400,
                  letterSpacing: '-0.02em',
                  mb: 2,
                }}
              >
                Your model,
                <br />
                your choice.
              </Typography>
              <Typography sx={{ fontSize: '0.938rem', color: '#666', lineHeight: 1.6 }}>
                One canonical Provider interface. Vendor differences stay behind it.
                Switch models mid-session with a slash command. No SDKs — direct
                fetch, explicit prompt-cache control.
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }}>
              <Stack spacing={1.5}>
                {providers.map((p) => (
                  <Box
                    key={p}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1.5,
                      p: 2,
                      bgcolor: '#FAFAFA',
                      borderRadius: 1,
                      border: '1px solid #EBEBEB',
                    }}
                  >
                    <Shield size={18} color={accent} strokeWidth={1.5} />
                    <Typography sx={{ fontSize: '0.938rem', fontWeight: 500 }}>
                      {p}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </Box>
          </Box>
        </Box>

        <Box id="install" sx={{ py: 10 }}>
          <Typography
            variant="h2"
            sx={{
              fontSize: '2rem',
              fontWeight: 400,
              letterSpacing: '-0.02em',
              mb: 1,
              textAlign: 'center',
            }}
          >
            Install
          </Typography>
          <Typography
            sx={{
              fontSize: '1rem',
              color: '#666',
              textAlign: 'center',
              mb: 5,
            }}
          >
            Prebuilt binaries. Requires Bun and ripgrep.
          </Typography>
          <Box sx={{ maxWidth: 640, mx: 'auto' }}>
            <Stack direction="row" spacing={0} mb={2}>
              {installs.map((inst, i) => (
                <Button
                  key={inst.label}
                  onClick={() => setActiveInstall(i)}
                  sx={{
                    textTransform: 'none',
                    fontWeight: i === activeInstall ? 600 : 400,
                    fontSize: '0.875rem',
                    color: i === activeInstall ? '#0D0D0D' : '#888',
                    borderBottom: `2px solid ${i === activeInstall ? '#0D0D0D' : 'transparent'}`,
                    borderRadius: 0,
                    px: 2.5,
                    py: 1,
                    minWidth: 'auto',
                    '&:hover': {
                      color: '#0D0D0D',
                      bgcolor: 'transparent',
                      borderBottomColor: '#CCC',
                    },
                  }}
                >
                  {inst.label}
                </Button>
              ))}
            </Stack>
            <Box sx={{ maxWidth: '100%', overflow: 'auto' }}>
              <CodeBlock>{installs[activeInstall].command}</CodeBlock>
            </Box>
          </Box>
        </Box>
      </Container>

      <Box
        component="footer"
        sx={{
          borderTop: '1px solid #EBEBEB',
          mt: 10,
          py: 6,
          textAlign: 'center',
        }}
      >
        <Container maxWidth="lg">
          <Stack direction="row" spacing={3} justifyContent="center" mb={3}>
            <Button
              href="https://github.com/TimAnthonyAlexander/ye"
              target="_blank"
              sx={{
                color: '#666',
                textTransform: 'none',
                fontSize: '0.875rem',
                fontWeight: 400,
                '&:hover': { color: '#000', bgcolor: 'transparent' },
              }}
              startIcon={<GitHubMark size={16} />}
            >
              GitHub
            </Button>
            <Button
              href="https://github.com/TimAnthonyAlexander/ye/blob/main/docs/OVERVIEW.md"
              target="_blank"
              sx={{
                color: '#666',
                textTransform: 'none',
                fontSize: '0.875rem',
                fontWeight: 400,
                '&:hover': { color: '#000', bgcolor: 'transparent' },
              }}
              startIcon={<BookOpen size={16} />}
            >
              Docs
            </Button>
          </Stack>
          <Typography sx={{ fontSize: '0.8125rem', color: '#AAA' }}>
            Ye is open source.{' '}
            <MuiLink
              href="https://github.com/TimAnthonyAlexander/ye"
              target="_blank"
              rel="noopener"
              underline="hover"
              sx={{ color: accent }}
            >
              GitHub
            </MuiLink>
          </Typography>
        </Container>
      </Box>
    </Box>
  );
}
