# Legal, attribution, and data notice

🇺🇸 **English** | [🇦🇷 Español](LEGAL.es.md)

Last reviewed: 2026-08-25

This document records the provenance and intended limits of SolarisPKN-Transport. It is provided for transparency and risk reduction; it is not legal advice and does not replace review by a qualified Argentine lawyer or written authorization from a data provider.

## Independent and unofficial status

SolarisPKN-Transport is an independent open-source interoperability project. It is not affiliated with, sponsored by, approved by, or endorsed by:

- Trenes Argentinos Operaciones or SOFSE;
- Nación Servicios S.A., SUBE, or Cuándo SUBO;
- any railway, bus company, transport agency, application store, or mobile-package distributor.

Names such as “Trenes Argentinos”, “SOFSE”, “SUBE”, “Cuándo SUBO”, and operator names are used descriptively to identify factual sources and routes. No third-party logo, visual identity, or claim of official status is included. All trademarks and service marks remain the property of their respective owners.

## Software and mobile packages

The GPL-3.0 license in this repository applies only to original SolarisPKN-Transport source code and contributions for which the contributor has sufficient rights. It does not relicense third-party software, trademarks, services, or data.

No APK, XAPK, APKS, AAB, decompiled application source, proprietary artwork, or copied application resource is distributed in the current repository or its Git history. Two user-supplied mobile packages were inspected locally for one-time compatibility research, were never committed, and were deleted after the audit. Only version identifiers, cryptographic hashes, observed protocol facts, and independently written connector code remain.

Repository policy prohibits committing mobile packages, signing stores, secrets, or decompilation output. Automated tests enforce the mobile-binary restriction.

## Data sources and attribution

| Source | Material used | Attribution and status |
|---|---|---|
| Trenes Argentinos Operaciones / SOFSE | Public-facing route, station, and timetable facts | Provider digital-service terms state that their content is licensed under CC BY 4.0 except where otherwise indicated. SolarisPKN-Transport retrieves, filters, normalizes, and reformats the information; those transformations are modifications. The project does not assume that every undocumented API element is necessarily covered by that statement. |
| Cuándo SUBO / Nación Servicios S.A. | Public-facing agency, route, stop, and timetable facts | The OneBusAway instance is reachable without a personal account, but no specific open-data license for the API dataset was found during this review. No ownership or open-license claim is made over this upstream material. Authorization for public redistribution should be confirmed with Nación Servicios. |
| Transport operators | Company names, route names, stops, and published times | Used descriptively to identify transport services. No endorsement, partnership, or ownership is claimed. |

Where CC BY 4.0 applies, the attribution is:

> Source: Trenes Argentinos Operaciones / Argentina.gob.ar. Timetable and infrastructure information was retrieved automatically and modified by filtering, normalization, validation, and conversion to XLSX/SQLite by SolarisPKN-Transport. Licensed under CC BY 4.0 where stated by the source. No endorsement is implied.

CC BY 4.0 requires appropriate credit, a license link, an indication of modifications, and no suggestion of endorsement. See <https://creativecommons.org/licenses/by/4.0/>.

Generated XLSX and SQLite artifacts contain factual timetable snapshots and source metadata. The project makes no claim that GPL-3.0 grants rights over upstream facts, provider databases, names, or marks. Downstream users are responsible for determining whether their intended redistribution, publication, or commercial use is authorized.

## API access and security boundaries

The connectors target interfaces observed in publicly distributed official applications. These interfaces are internal or undocumented and may change or be withdrawn without notice. Technical accessibility is not treated as legal authorization.

The project:

- does not use passenger accounts, SUBE card identifiers, travel histories, payment information, or other personal data;
- does not store personal passwords or long-lived user tokens;
- does not bypass paywalls, user-account controls, or access to private records;
- does not perform vulnerability scanning, exploitation, load testing, or security-control evasion;
- caches catalogs, bounds stop requests, serializes updates, and runs at low frequency to reduce provider load;
- stops or preserves the last local snapshot when a provider refuses access or returns unsafe data.

The SOFSE connector reproduces a compatibility authentication flow observed in a public client and obtains a temporary service token. Because the interface is authenticated and not documented as a public developer API, deployment without provider authorization remains a legal and contractual uncertainty. For the lowest-risk public deployment, obtain written permission or an official developer credential from SOFSE.

The Cuándo SUBO connector uses the public client key `web` and no personal credential. Its availability does not establish a redistribution license. Written clarification from Nación Servicios is recommended before operating a public mirror or commercial service.

## Privacy

This repository is designed to process public transport schedules, not people. The audit found no passenger records, precise user locations, card numbers, transaction histories, email addresses, authentication cookies, or other personal datasets. Contributors must not add such information.

## Removal and rights-holder requests

If you represent a rights holder and believe a file or dataset should not be present:

1. open a GitHub issue identifying the exact file or material and the right or term involved; or
2. use GitHub’s private vulnerability-reporting channel when the report contains credentials or sensitive security information.

Do not publish secrets or personal information in a public issue. Substantiated requests will be reviewed promptly, and disputed material can be disabled or removed while the issue is assessed.

## Known unresolved items

- No written authorization from SOFSE for this independent connector is stored in the repository.
- No explicit open-data license for the Cuándo SUBO OneBusAway API dataset was located during the 2026-08-25 review.
- Provider terms, endpoints, and licensing statements can change.

Accordingly, this repository can be made transparent and cautious, but no contributor can honestly guarantee that it is immune from complaints. A qualified lawyer and written provider permissions are recommended before high-traffic, commercial, or public-mirroring use.
