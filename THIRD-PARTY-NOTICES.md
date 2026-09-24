# Third-Party Notices

This project's own code and documentation are under the [MIT License](LICENSE). It
builds on the components below, each under its own license. Only two are vendored into
this repository: the Roboto fonts in `web/fonts/` and the Font Awesome icon in
`web/images/favicon.svg`.

## Shipped in the Published Pages

These end up in the generated `site/` and are therefore served to guests.

| Component | Where | License |
| --- | --- | --- |
| [Material for MkDocs](https://github.com/squidfunk/mkdocs-material) | Theme HTML, CSS and JavaScript in `site/assets/` | MIT |
| [Font Awesome Free](https://fontawesome.com) — icon `hand-spock` | Header logo (inline SVG) and `web/images/favicon.svg` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (icons) |
| [Material Design Icons](https://pictogrammers.com/library/mdi/) (Pictogrammers) — icon `qrcode` | QR button (inline SVG) | [Pictogrammers Free License](https://pictogrammers.com/docs/general/license/) (icons: Apache 2.0) |
| [Roboto](https://github.com/googlefonts/roboto-classic) — Copyright 2011 The Roboto Project Authors | `web/fonts/Roboto-*.woff2`, text font | [SIL Open Font License 1.1](web/fonts/Roboto-OFL.txt) |
| [Roboto Mono](https://github.com/googlefonts/robotomono) — Copyright 2015 The Roboto Mono Project Authors | `web/fonts/RobotoMono-*.woff2`, code font (admin page) | [SIL Open Font License 1.1](web/fonts/RobotoMono-OFL.txt) |

The Font Awesome attribution required by CC BY 4.0 is kept in the comment inside
`web/images/favicon.svg` and in this file. The only change to the icon is its fill color.

The font files are unmodified WOFF2 files as distributed by Google Fonts (variable weight,
Latin and Latin Extended subsets). The OFL requires the license to accompany the fonts:
`Roboto-OFL.txt` and `RobotoMono-OFL.txt` sit next to them and are published with the pages.

## Provided by the Platform, Not Redistributed

| Component | How | License |
| --- | --- | --- |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-s3`) | Provided by the AWS Lambda Node.js runtime; not bundled into the function | Apache 2.0 |

## Build, Deploy and Test Tools

Installed by the person deploying; not part of the published output.

| Component | Used for | License |
| --- | --- | --- |
| [MkDocs](https://github.com/mkdocs/mkdocs) | Building `web/` into `site/` | BSD 2-Clause |
| [PyMdown Extensions](https://github.com/facelessuser/pymdown-extensions) | Markdown extensions (admonitions, icons, code blocks) | MIT |
| [Terraform](https://github.com/hashicorp/terraform) 1.5 and the `hashicorp/aws`, `hashicorp/random`, `hashicorp/archive` providers | Infrastructure | MPL 2.0 (Terraform ≤ 1.5.7 and the providers) |
| AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) | Dev dependencies of the offline tests in `tests/` | Apache 2.0 |
| [moon](https://github.com/moonrepo/moon) | Optional task runner | MIT |
| [qrencode](https://fukuchi.org/works/qrencode/) | Optional, for creating the QR code image | LGPL 2.1 |
