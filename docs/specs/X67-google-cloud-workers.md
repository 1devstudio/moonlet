# X67 — Google Cloud workers: a Compute Engine adapter for cloud machines

- **Status:** implemented (untried with a real Google Cloud project: the adapter is built and tested against responses written from Compute Engine's published API description, marked provisional in `crates/moonlet-cloud/src/fixtures/README.md`, until a sandbox key captures real ones)
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0012](../adr/0012-cloud-workers.md) (cloud workers through provider adapters)
- **Depends on:** [X63](X63-cloud-workers.md) (cloud workers, the provider adapter with `locations` and `images`).

## Summary

X63 rents cloud machines through provider adapters, and Hetzner Cloud is the only one so far. This spec adds Google Cloud's Compute Engine as a second adapter, so a user with a Google Cloud project can run heavy commands on its machines. Nothing outside the adapter changes: making, pairing, routing, idle removal, limits and the sweep are X63's.

The adapter calls Compute Engine's REST API (`https://compute.googleapis.com/compute/v1`) with no Google client library. It signs in with a service-account key the user pastes. Google bills a machine by the second with a one-minute minimum, so an idle machine is removed at the idle time, with no paid hour to wait for. Google also deletes each machine by itself after a time limit the user sets, so a machine is never left billing when the central host is off.

## User journey

1. In the Google Cloud console, the user makes a project for moonlet, `acme-moonlet`, with billing on and the Compute Engine API turned on. They make a service account `moonlet`, give it the role **Compute Instance Admin (v1)** on the project, and download a JSON key.
2. On the MacBook, in Settings › Machines › Cloud workers for `studio-mini`, they click **Add provider › Google Cloud** and paste the key's JSON. They leave **Longest a machine lives** empty, which means 12 hours, and save.
3. In Settings › Projects › shop (studio-mini), under **Cloud workers**, they pick provider **Google Cloud**, location "europe-west4-a · Eemshaven, NL", machine type "c4-standard-8 · 8 cores · 30 GB · x86" and image "Ubuntu 24.04 LTS (x86)".
4. They click **Start a machine**. The Workers screen shows `moonlet-shop-7k2q` as "Starting", and its first step reads "Created at Google Cloud". The machine joins the tailnet, installs moonlet and pairs, as in X63.
5. Routed commands run there. Fifteen minutes after the last one ends, the machine is removed, and the Cloud workers page counts the time it existed.
6. One evening the central host loses power while a machine is idle. Twelve hours after the machine started, Google deletes it. The next sweep of `studio-mini` finds it gone and books its time.

## Behaviour and acceptance criteria

### The adapter's description

- [x] The provider's id is `gcp` and its label is "Google Cloud". Its machine names are at most 63 characters, and its machines join the tailnet with a one-off Tailscale key. It bills every started second with a minimum of 60 seconds: `billing {unit_secs: 1, minimum_secs: 60}`.
- [x] Its settings fields are:
  - `key`, secret, "Service account key (JSON)", with the help "A key of a service account with the Compute Instance Admin (v1) role. It can create and delete any machine in its project, so use a project made for moonlet.";
  - `max_hours`, not secret, "Longest a machine lives (hours)", with the help "Google Cloud deletes a machine this long after it starts, even while the central host is off. A command still running then is cut off. Empty means 12."
- [x] **Add provider** lists Google Cloud after Hetzner Cloud. The line under the provider cards no longer says Hetzner Cloud is the only provider.

### The service-account key

- [x] `cloud.set` refuses a `key` that is not a service-account key, and saves nothing. The key is JSON with `"type": "service_account"`, `project_id`, `client_email`, `private_key_id` and `private_key`, the last an RSA private key in PKCS #8 PEM. Each refusal names what is wrong:
  - not JSON: "That is not a Google Cloud service-account key: it is not JSON.";
  - another kind of credential, such as an OAuth client's JSON: "That is not a Google Cloud service-account key: its type is not service_account.";
  - a missing field: "That is not a Google Cloud service-account key: it has no project_id." (and the same for the other fields);
  - a private key that does not read: "That is not a Google Cloud service-account key: its private_key is not an RSA key."
- [x] A key pasted into the one-line field loses its line breaks. It still reads, since JSON needs none between its values, and the private key's line breaks are written as `\n` inside its string.
- [x] A field of spaces alone is saved as no value, so a key of spaces never shows as saved.
- [x] `cloud.set` refuses a `max_hours` that is not a whole number from 1 to 2880 (120 days, Google's limit): "Longest a machine lives must be a whole number of hours from 1 to 2880."
- [x] The adapter works in the key's `project_id`. No other field names the project.

### Signing in

- [x] The adapter gets an access token as Google's server-to-server OAuth flow describes. It signs a JWT with RS256 and the key's private key. The JWT's header is `{"alg":"RS256","typ":"JWT","kid":<private_key_id>}`, and its claims are `iss` (the key's `client_email`), `scope` `https://www.googleapis.com/auth/compute`, `aud` `https://oauth2.googleapis.com/token`, `iat` (now) and `exp` (now + 3600). It posts the JWT as a form, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion=<jwt>`, to `https://oauth2.googleapis.com/token`, and sends the answer's `access_token` as `Authorization: Bearer <token>`.
- [x] RS256 signatures come out the same each time for the same input, so the test signs a fixed claim set with a test key and compares the JWT with a literal.
- [x] The token is reused until 5 minutes before its `expires_in` ends, across adapter calls. A new key, even one with the same account and key id but another private key, or a 401 from Compute Engine, gets a new token.
- [x] The token endpoint's refusal (400 `invalid_grant`, 401) reads "Google Cloud refused the service-account key: <its error_description>. Check it in Settings › Cloud workers." It is a refused credential, as Hetzner's 401 is.

### Compute Engine calls

Paths are under `https://compute.googleapis.com/compute/v1/projects/<project>`.

- [x] **`locations`:** `GET /zones`, every page (`pageToken` to `nextPageToken`), the zones whose `status` is `UP`. Each is `{name: "europe-west4-a", label: "europe-west4-a · Eemshaven, NL"}`: the zone, then the city of its region from a table in the adapter. A region missing from the table shows only the zone.
- [x] **`machine_types(zone)`:** `GET /zones/<zone>/machineTypes`, every page. It keeps the types of the families `e2`, `n2`, `n2d`, `n4`, `c3`, `c3d`, `c4`, `c4a`, `c4d`, `t2a` and `t2d`, in their `standard`, `highcpu` and `highmem` shapes. It leaves out deprecated types, shared-core types (`isSharedCpu`), and types with local SSDs (`-lssd`) or whole hosts (`-metal`). Each is `{name, cores: guestCpus, memory_gb: memoryMb / 1024, arch}`, `arch` being `x86` for `X86_64` and `arm` for `ARM64`. Worked example: `c4-standard-8` with 8 vCPUs and 30720 MB is "c4-standard-8 · 8 cores · 30 GB · x86".
- [x] **`images`:** the Ubuntu LTS image families that run cloud-init, then the project's own images. The families are:
  - `ubuntu-os-cloud/ubuntu-2404-lts-amd64`, "Ubuntu 24.04 LTS (x86)";
  - `ubuntu-os-cloud/ubuntu-2404-lts-arm64`, "Ubuntu 24.04 LTS (Arm)";
  - `ubuntu-os-cloud/ubuntu-2604-lts-amd64`, "Ubuntu 26.04 LTS (x86)";
  - `ubuntu-os-cloud/ubuntu-2604-lts-arm64`, "Ubuntu 26.04 LTS (Arm)".

  A family always gives its newest image. The project's own images come from `GET /global/images`, every page, those `READY` and not deprecated. Each is named by its image name, labelled by its description or else its name, with the architecture of its `architecture` (an image without one is `x86`).
- [x] **`create`:** `POST /zones/<zone>/instances` with a `requestId`, a UUID made from the machine's name, so a retried call makes no second machine and:
  - `name`, `machineType: "zones/<zone>/machineTypes/<type>"`, `labels`;
  - one boot disk with `autoDelete: true`, `initializeParams.sourceImage` (`projects/ubuntu-os-cloud/global/images/family/<family>` for a family, `projects/<project>/global/images/<name>` for an own image), `diskSizeGb: 50`, and `diskType: "zones/<zone>/diskTypes/<type>"`. The type is `hyperdisk-balanced` for the families `c4`, `c4a`, `c4d` and `n4`, which take no Persistent Disk, and `pd-balanced` for the others;
  - `networkInterfaces: [{network: "global/networks/default", accessConfigs: [{type: "ONE_TO_ONE_NAT"}]}]`. The external address lets the machine reach Tailscale and GitHub; nothing reaches it from outside but Tailscale;
  - `metadata.items`: `user-data`, X63's cloud-init script, which Ubuntu's cloud-init runs once at first boot, and `block-project-ssh-keys: "TRUE"`;
  - `serviceAccounts: []`, so the machine holds no Google credentials;
  - `scheduling: {maxRunDuration: {seconds: <max_hours × 3600>}, instanceTerminationAction: "DELETE"}`.

  The machine's provider id is `<zone>/<name>`.
- [x] `create` looks at the insert's operation every 5 s with `GET /zones/<zone>/operations/<operation>`. It does not use Google's wait call, which can hold a request for 2 minutes, past the daemon's 30 s request timeout. An operation that ends with an `error` fails `create` with its first error's code and message, such as "ZONE_RESOURCE_POOL_EXHAUSTED: The zone 'projects/acme-moonlet/zones/europe-west4-a' does not have enough resources available to fulfill the request." Quota (`QUOTA_EXCEEDED`) and capacity errors only appear there, never as the insert's own answer. After 4 minutes without `DONE`, or when a look fails, `create` returns the id: the insert was taken, so the machine may exist, and X63's startup deadline and sweep take over.
- [x] **`get`:** `GET /zones/<zone>/instances/<name>`. `RUNNING` is `running`, a 404 is `gone`, and every other status is `starting`. `ipv4` is the first network interface's `accessConfigs[0].natIP`.
- [x] **`list(labels)`:** `GET /aggregated/instances` with `filter` set to one `(labels.<key> = "<value>")` per label, every page, the instances of every zone. Each is `{id: "<zone>/<name>", name, labels, created_at}`, `created_at` from `creationTimestamp` (RFC 3339) in Unix ms.
- [x] **`destroy`:** `DELETE /zones/<zone>/instances/<name>`. A 404 is done. The boot disk goes with the machine.

### Errors

- [x] A 401 from Compute Engine gets a new token and tries once more; a second 401 is a refused credential.
- [x] A 403 whose reason is `SERVICE_DISABLED` or `accessNotConfigured` reads "The Compute Engine API is off in acme-moonlet. Turn it on at https://console.cloud.google.com/apis/library/compute.googleapis.com?project=acme-moonlet, wait a few minutes and try again."
- [x] A 403 whose reason is `rateLimitExceeded` or `userRateLimitExceeded`, and a 429, are retried after 5 s, 3 tries in all, as Hetzner's 429 is.
- [x] Any other 403 reads "Google Cloud refused moonlet@acme-moonlet.iam.gserviceaccount.com: <message>. It needs the Compute Instance Admin (v1) role on acme-moonlet." It is a refused credential.
- [x] Other errors show Google's `error.message` after the status, as Hetzner's do.

### Idle time and usage

- [x] With per-second billing, X63's rule removes an idle machine at the idle time, never waiting for a paid unit. Worked examples, for a machine made at 10:00:00 and ready at 10:01:30: with idle time 15 minutes and its command ending at 10:05, it is removed at 10:20; with idle time 0 and its command ending at 10:03, it is removed at 10:03. Within its first minute, which is paid in full, an idle machine stays until just before that minute ends. A machine made at 10:00:00 and gone at 10:00:40 is booked as 60 s.
- [x] A machine that Google deleted at its time limit is gone for `get` and `list`. X63's rules book its time and drop it as for any machine its provider lost.

## UI

No new screens: X63's forms are built from the adapter's description.

- **Settings › Machines › Cloud workers:** the provider card "Google Cloud" with the two fields. The key's field shows "Saved" with **Replace** once saved, as Hetzner's token does. The line under the cards reads "Hetzner Cloud and Google Cloud so far."
- **Project page, Cloud workers:** the Location, Machine type and Image dropdowns, as X63 has them, filled from this adapter.
- **Workers page and startup steps:** "Created at Google Cloud" as the first step.
- **Settings search:** "Google Cloud" and "GCP" find the Cloud workers page.

## Protocol and RPCs

- `cloud.get`'s `kinds` gains `gcp`, with its fields and `billing_unit_secs: 1`. A saved key shows as `has_key: true`.
- `cloud.set` refuses a `gcp` provider whose `key` or `max_hours` is wrong, with the messages above, as `invalid_params`.
- No new RPC.

## Data and config

- **`$MOONLET_HOME/cloud.json`:** `"providers": {"gcp": {"key": "<the key's JSON>", "max_hours": "12"}}`. A project's cloud setting is, for example, `{"provider": "gcp", "type": "c4-standard-8", "location": "europe-west4-a", "image": "ubuntu-os-cloud/ubuntu-2404-lts-amd64"}`.
- The access token is kept in memory only.

## Security considerations

- **The service-account key** can create and delete any machine in its project, and with the Compute Instance Admin role it can also attach service accounts to machines it makes. It is stored only in `cloud.json` (mode 0600), never returned by `cloud.get`, and never written to logs or `user-data`. The help asks for a project made for moonlet.
- **The machine holds no Google credentials:** it has no service account, so its metadata server gives no token.
- **`user-data` is readable** through the API, by anyone with access to the project, and from inside the machine, as on Hetzner. It holds the one-off Tailscale key and the join code (X63).
- **SSH:** Google's `default` network allows SSH from anywhere. The machine has no SSH key: `block-project-ssh-keys` keeps the project's keys off it, and moonlet adds none. Tailscale is the only way moonlet reaches it.
- **Spending:** besides X63's limits, Google deletes each machine after `max_hours`, so a central host that is off or has lost its records leaves nothing billing past that time.
- **Organisations:** an organisation made on or after 3 May 2024 blocks service-account keys by default (`iam.managed.disableServiceAccountKeyCreation`). A project outside any organisation is not affected. The user, not moonlet, decides whether to lift the policy.

## Out of scope

- Other ways to sign in: workload identity federation, `gcloud`'s login, an OAuth client.
- Choosing the network, subnetwork, disk size or disk type. The machine uses the `default` network and a 50 GB disk.
- Spot machines, GPUs, sole-tenant nodes and reservations.
- Prices in the UI.
- Images without cloud-init, such as Debian's and Container-Optimized OS. An own image must run cloud-init.

## Test plan

Each criterion maps to at least one test. The names are the planned ones; a pull request that renames a test updates this table. Expected values are literals from this spec or from captured responses.

- **Rust unit tests:** `crates/moonlet-cloud/src/gcp.rs` and `gcp_auth.rs`, against responses in `crates/moonlet-cloud/src/fixtures/gcp/`. Until a sandbox key captures real ones, the fixtures follow Compute Engine's published API description (discovery revision 20261016) and are marked PROVISIONAL in the fixtures README.
- **Daemon end-to-end:** `crates/moonletd/tests/cloud.rs`.
- **Vitest:** `apps/desktop/src/lib/cloudSettings.test.ts` and `settingsSearch.test.ts`.

| Criterion | Tests |
|---|---|
| The adapter's description | `describes_google_cloud_and_its_billing`; `cloud_get_lists_google_cloud_after_hetzner`, `the_fake_provider_is_off_without_its_setting` |
| The service-account key | `reads_a_service_account_key`, `refuses_what_is_not_a_service_account_key`, `a_key_without_line_breaks_still_reads`, `max_hours_is_a_whole_number_from_1_to_2880`, `checks_a_typed_field`; `cloud_set_refuses_a_bad_google_cloud_key` |
| Signing in | `signs_the_token_request_as_the_worked_jwt`, `asks_for_a_token_with_the_signed_jwt`, `reuses_the_token_until_five_minutes_before_it_expires`, `a_new_private_key_gets_its_own_token`, `a_refused_key_says_so` |
| Locations, types, images | `reads_every_page_of_zones`, `keeps_the_machine_types_for_builds`, `offers_ubuntu_families_then_own_images` |
| Create | `creates_an_instance_as_in_the_captured_request`, `hyperdisk_for_c4_and_n4_pd_balanced_for_the_others`, `waits_for_the_insert_and_reports_its_error`, `returns_the_id_after_four_minutes_without_done`, `a_look_that_fails_leaves_the_machine_to_its_startup_deadline` |
| Get, list, destroy | `reads_a_captured_instance`, `a_404_means_gone`, `lists_instances_by_label_across_zones`, `a_404_on_delete_is_done`, `an_id_without_a_zone_is_an_error` |
| Errors | `a_401_gets_a_new_token_once`, `an_api_that_is_off_says_where_to_turn_it_on`, `a_rate_limit_is_retried`, `a_missing_role_says_which_one`, `another_error_shows_googles_message` |
| Idle time and usage | `removes_at_the_times_in_the_per_second_examples` |
| UI line under the cards, search | Vitest "names the providers on offer", "finds the Cloud workers page, its Tailscale client and its limits" |

**Manual, once before the status says implemented:** with a sandbox key, a real Compute Engine machine starts from the project page, runs a routed `./check.sh` for a throwaway project, and is removed after the idle time; the console shows no instance or disk left. A second machine with `max_hours` 1, left alone with the central host stopped, is gone an hour after it started. The captured responses replace the provisional fixtures.

## Open questions

- **Region cities:** the table of region cities is written from Google's list of regions and needs updating as regions open. Unknown regions show the zone alone.

Decided by the user on 2026-10-25:

- A service-account JSON key is the only way to sign in for now.
- The time after which Google deletes a machine by itself is a user setting (`max_hours`).
