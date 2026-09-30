# Contributing to Meridian HRMS

Thanks for helping. Issues and pull requests are welcome.

## Getting set up

```bash
docker compose up -d          # Postgres 16 on 127.0.0.1:5432
npm install
cp .env.example .env          # fill AUTH_SECRET and PLATFORM_ENCRYPTION_KEY (see README)
npm run db:migrate
ALLOW_DESTRUCTIVE_SEED=1 npm run db:seed
npm run dev
```

## Before you open a pull request

```bash
npm run verify
```

That runs the type checker, the test suite and a real production build. `tsc`
alone does not catch everything a build does.

## Ground rules

* Business logic belongs in `src/domain/` — pure functions, no framework, no
  Prisma — with tests next to it. Money is integer paise; dates are
  `"YYYY-MM-DD"` strings.
* Every service takes an `AuthContext`, and every query is scoped to the
  caller's organisation. A cross-tenant read must return 404, not 403.
* Anything sensitive (PAN, Aadhaar, bank details, keys) goes through the crypto
  helpers in `src/lib/`; never log it.
* Keep pull requests focused. Explain the *why* in the description.
* By contributing you agree your contribution is licensed under the
  [AGPL-3.0](LICENSE), the same as the project.

## Security issues

Please don't file them publicly — see [SECURITY.md](SECURITY.md).
