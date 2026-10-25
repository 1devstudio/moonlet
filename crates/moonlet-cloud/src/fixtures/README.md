# Provider fixtures

Captured from Hetzner Cloud's API on 2026-10-25, with a project made for moonlet:
`hetzner/locations.json`, `hetzner/images_system.json`, `hetzner/images_snapshot.json`
and `hetzner/server_types.json`. They hold no secrets.

PROVISIONAL: the other files follow the examples in Hetzner Cloud's and Tailscale's
published API references, not captured traffic. X63 asks for captured,
sanitised responses; replace each file with one captured from a sandbox
project, keeping the file names, and rerun the tests.

`gcp/test_key.pem` is an RSA key made with `openssl genpkey` for these tests
only; no Google account knows it. `gcp/worked_jwt.txt` is the JWT that X67's
worked claims make with it, signed with `openssl dgst -sha256 -sign`.
