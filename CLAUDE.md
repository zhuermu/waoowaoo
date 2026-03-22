# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

waoowaoo is an AI-powered short drama/comic video production studio. It takes novel text as input and automatically generates storyboards, characters, scenes, and assembles them into complete videos with AI voiceover.

## Tech Stack

- **Framework**: Next.js 15 + React 19 (App Router, Turbopack)
- **Database**: MySQL 8.0 + Prisma ORM
- **Queue**: Redis 7 + BullMQ (image/video/voice/text workers)
- **Styling**: Tailwind CSS v4
- **Auth**: NextAuth.js
- **i18n**: next-intl (Chinese/English, locale in URL path)
- **Testing**: Vitest
- **Node**: 22.14.0

## Common Commands

```bash
# Development (starts Next.js + workers + watchdog + Bull Board)
npm run dev

# Build
npm run build          # runs prisma generate + next build

# Lint
npm run lint

# Run all tests (full regression)
npm run test:regression

# Run a single test file
BILLING_TEST_BOOTSTRAP=0 npx vitest run tests/unit/worker/xxx.test.ts

# Run test suites by area
npm run test:unit:all                    # all unit tests
npm run test:behavior:unit               # worker/helper/optimistic behavior tests
npm run test:behavior:api                # API contract tests
npm run test:integration:api             # API integration tests
npm run test:integration:chain           # queue-to-worker chain tests
npm run test:billing                     # billing with coverage

# Guard checks (static analysis scripts)
npm run test:guards                      # API handler + coverage guards
npm run check:config-center-guards       # model config guards
npm run check:test-coverage-guards       # test coverage guards
```

Set `BILLING_TEST_BOOTSTRAP=0` for unit tests that don't need billing bootstrap, `=1` for integration/concurrency billing tests.

## Architecture

### Runtime Processes

`npm run dev` starts 4 concurrent processes:
1. **Next.js app** (`dev:next`) - web UI and API routes
2. **BullMQ workers** (`dev:worker`) - process image/video/voice/text queues
3. **Watchdog** (`dev:watchdog`) - monitors task heartbeats, handles timeouts
4. **Bull Board** (`dev:board`) - queue admin dashboard (port 3010)

### Source Layout (`src/`)

- `app/[locale]/` - Next.js pages (locale-prefixed routes: workspace, profile, auth)
- `app/api/` - API routes (novel-promotion, tasks, runs, sse, asset-hub, etc.)
- `lib/workers/` - BullMQ worker definitions; `handlers/` contains all task handler logic
- `lib/ai-runtime/` - unified AI runtime client abstraction
- `lib/llm/` and `lib/llm-client.ts` - LLM integration layer
- `lib/media/` - media processing, image URLs, outbound image handling
- `lib/billing/` - billing system (cost, ledger, usage, service)
- `lib/model-capabilities/` and `lib/model-pricing/` - model config center
- `lib/prompt-i18n/` - prompt internationalization
- `lib/task/` - task management utilities
- `lib/novel-promotion/` - core novel-to-video pipeline logic
- `features/video-editor/` - video editor feature module
- `components/` - shared React components
- `i18n/` - next-intl routing and message config

### Prompt Templates

`lib/prompts/` contains bilingual (`.en.txt` / `.zh.txt`) prompt templates organized by feature (novel-promotion, character-reference).

### Test Structure

- `tests/unit/worker/` - worker handler behavior tests (primary regression defense)
- `tests/unit/helpers/` - pure function / utility tests
- `tests/unit/optimistic/` - frontend state hook tests
- `tests/integration/api/contract/` - API route contract tests (401/400/200 + payload)
- `tests/integration/chain/` - queue-to-worker-to-result chain tests
- `tests/contracts/` - route/tasktype matrices and guards
- `tests/helpers/fakes/` - shared mock utilities (llm, media, providers)

### Docker

`docker compose up -d` starts MySQL, Redis, and the app. Ports: app on 13000, MySQL on 13306, Redis on 16379. Optional Caddy for HTTPS (port 1443).

## Key Conventions (from AGENTS.md)

- **No `any` types** - all types must be explicit
- **No compatibility layers** - no dual-track logic, no legacy compat shims
- **No silent fallbacks** - no auto-model-downgrade, no default values hiding missing data, no swallowing errors. Fail explicitly.
- **Icons**: import through `@/components/ui/icons` only, never from `lucide-react` directly or inline `<svg>`
- **Path alias**: `@/` maps to `src/`
- **Prompts must be bilingual**: every `.en.txt` needs a `.zh.txt` counterpart

## Testing Rules

- Every worker/handler change, bug fix, new API route, or new task type requires tests
- Bug fixes must include a regression test with `it()` name describing the bug scenario
- Assertions must check concrete values (DB fields, function args, return values), not just `toHaveBeenCalled()`
- No "self-answering" tests: mock returns X then asserts X without business logic in between
- Test file structure: `vi.hoisted` mocks -> `vi.mock` registrations -> real imports -> `describe` + `beforeEach(vi.clearAllMocks)`
- `it()` naming format: `[condition] -> [expected result]`
- Must mock: prisma, LLM calls, COS/upload, external HTTP. Must NOT mock: the business function under test
