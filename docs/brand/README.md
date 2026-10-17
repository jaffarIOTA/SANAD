# Brand mark

**Status: interim.** Decided by the product owner on 2026-10-10.

The mark in `packages/design/primitives.tsx` (`BrandMark`) and the app icons (`apps/*/src/app/icon.svg`) is the
symbol of logo 07 from the "Fontana Logo Collection" pack (Studio Dara). The product owner bought the pack from a
community forum. The paths are taken unchanged from the pack's vector (AI) original, and the pack's own wordmark and
tagline are not used. The product's name is set as text: "Sanad" in the apps and "سند" in Arabic.

Constraints while it is interim:

- **Not exclusive.** Every buyer of the pack has the same symbol, so it cannot be registered as a trademark.
- **Licence unconfirmed.** A forum purchase may not carry the pack author's licence for use as a product logo. Do not
  use it in print, on a client contract, in a trademark filing or in marketing outside the hosted synthetic
  environment.
- **Offer letters.** The demo tenants' letterhead (`config/branding/sanad-interim.json`, generated from the colour
  logo files here) is marked `INTERIM_SYNTHETIC_ONLY`. The ops app prints it on a rendered letter only where a
  synthetic demonstration is permitted, and a deployed letter prints without a logo. An institution's own letterhead
  goes in its own brand file with `markStatus: "OWNED"`, named from `config/tenants/<t>/documents/letter-branding.json`.
- **To replace it,** license (or commission) a mark the product owner owns. Then replace the four paths in
  `BrandMark` and each app's `icon.svg`, and change this file's status.

The source pack is kept outside the repository. Its files are not committed.
