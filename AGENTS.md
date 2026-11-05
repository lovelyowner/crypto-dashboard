# Development delivery

- Use `preview` for ongoing development. After a completed, validated batch, commit and push `origin preview`. Keep `main` unchanged unless the user explicitly requests production publication.
- Report a verified Vercel branch preview URL when available. A successful Git push alone does not prove a deployment is ready. Do not guess deployment URLs.
- Prefer a short changelog and the existing preview link. Build downloadable HTML, ZIPs, or screenshots when requested rather than after every change.
- Run checks relevant to the change, plus typecheck/lint. Verify the hosted build when deployment configuration changes. Keep test output concise.
- Vercel previews use separate `PREVIEW_DATABASE_URL`, `PREVIEW_BETTER_AUTH_SECRET`, and `PREVIEW_BETTER_AUTH_URL`; never fall back to production account credentials. See `docs/preview-workflow.md`.
- Preserve the UI palette: white backgrounds, `#ccc` borders/outlines, `#999` text 1/icons, `#666` text 2, and `#333` text 3. Footer destinations stay `https://lovelyowner.com/` until the user supplies replacements.
