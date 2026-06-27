# 00 - Implementation discipline

**Implementation decisions must only be made after deeply reviewing the existing code.**

Before proposing or writing any change:

1. Read the relevant models, services, and utilities end-to-end - in this repo **and** in the source platform [build-3/founders-directory-platform](https://github.com/build-3/founders-directory-platform) when the change touches data shapes, matching, or search.
2. Prefer reusing existing functions, patterns, and enums over introducing new ones. In particular, reuse:
   - the source platform's **cofounder matching prompt** and 7-factor scoring/reason-tone rules (mirrored in `src/domain/matchingPrompt.js`),
   - the source `Founder` **field enums** (sector, startupStage, lookingFor, dharma, program, role),
   - the search semantics from the source `utils/search.js`.
3. Document, in the PR/commit description, **what existing code you reviewed** and **what you are reusing**.

## Hard constraints for this project

- **Never write to the source platform or its database.** It is read-only. We consume `GET /api/v1/getListedUsers` only.
- WhatsApp signups (later phases) are **native Supabase rows** (`origin = 'whatsapp'`) and stay in this system. No export/write-back.
- Secrets (Meta, OpenAI, Supabase service key, source `X-API-Key`, Coolify token) live in the deploy environment - **never commit them**.

## Writing style (universal)

- **Never use em dashes (—) or en dashes (–)** anywhere: user-facing copy, the system prompt, code comments, or docs. Use a comma, colon, period, or a plain hyphen (-) instead. The system prompt also instructs the model to follow this in every reply.
