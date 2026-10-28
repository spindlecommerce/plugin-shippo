# Shippo, a SpindleCommerce plugin

Live carrier rates at checkout and shipping labels at fulfilment, through
[Shippo](https://goshippo.com): USPS, UPS, FedEx, DHL Express and the other carriers connected to
the Shippo account. Rates are cached for 10 minutes and never fetched while an order is being
placed, so a slow carrier cannot hold up checkout.

## Setup

1. **Add the plugin** to your SpindleCommerce installation and deploy:

   ```bash
   pnpm add @spindlecommerce/plugin-shippo
   ```

   ```ts
   // ecom.config.ts
   import { shippo } from "@spindlecommerce/plugin-shippo";

   export default defineConfig({ plugins: [email(), stripe(), shippo()] });
   ```

2. **Settings › Plugins › Shippo.** Enter the API token from Shippo › Settings › API. On a server,
   the `SHIPPO_API_TOKEN` environment variable can supply it instead. **Test connection** lists the
   carrier accounts the token can use.

3. **Connect carriers in Shippo.** Shippo includes its own accounts for some carriers. Add your own
   carrier accounts there for the others.

4. **Set the ship-from address.** Rates use the address of the channel's ship-from location: the
   first active stock location with an address, under Settings › Locations.
   - Labels need a full address, with a street, name and phone.
   - If the locations lack one, fill in the plugin's Ship-from settings.
   - Their address is used whenever its street is set.

5. **Settings › Shipping.** Add a method to a zone and pick the **Shippo** tab. Every rate Shippo
   returns for the cart becomes a choice at checkout. Its options are:

   | Option | Effect |
   |---|---|
   | Carriers | Comma-separated carrier names (`USPS, UPS`). Empty offers every carrier. |
   | Service levels | Comma-separated Shippo tokens (`usps_priority, ups_ground`). Empty offers all. |
   | Markup (%) | Added to the carrier's price. |
   | Handling fee | Added to every rate, in minor units of the cart's currency (`150` is 1.50). |

   Use several methods to present services differently: for example "Economy" with
   `usps_ground_advantage` and "Express" with `ups_next_day_air`.

## Settings

- **API token** (secret, `SHIPPO_API_TOKEN`).
- **Parcel length, width and height** in cm (default 30 × 20 × 10). Products only have weights, so
  each cart and each shipment is quoted as one parcel of this size, weighing what its items weigh.
- **Label format:** a PDF on a letter or A4 sheet, a 4 × 6 in PDF (the default), or ZPL II for
  thermal printers.
- **Ship-from address:** name, street, city, state or region, postal code, country, phone and email.
  - When the street is set, this address replaces the location's.
  - Otherwise only the name, phone and email are used, added to the location's address.

## Labels

When staff fulfil an order with **Buy a label with Shippo**, the plugin quotes the shipment again
with the units being shipped. It then buys the label for the service the customer chose, matched by
service level token. Orders that did not use Shippo get the cheapest rate offered.

The shipment keeps:
- the tracking number;
- a link to the carrier's tracking page;
- the label's PDF or ZPL link;
- the label's cost.

If the service is no longer offered (for instance because the parcel is now too heavy for it),
nothing is bought and the error says so. In that case, buy the label in Shippo or ship without one.

## Test mode

Test tokens (`shippo_test_…`) quote real rates and buy free sample labels, with test tracking
numbers. **Test connection** says which kind of token is in use. Switch to a live token
(`shippo_live_…`) to buy real labels, which Shippo charges to the account.

## Limitations

- **No currency conversion.** Only rates in the cart's currency are offered, and Shippo quotes in
  the currency of the account or the origin country. A store selling in several currencies sees
  Shippo rates only in carts of the matching currency.
- **One parcel per shipment**, of the default size.
  - Products without a weight count as weightless.
  - An empty parcel is sent as 1 g.
  - Set product weights.
- **Voiding a label** is done in Shippo's dashboard. If a label was bought but the shipment could not
  be recorded, the order's timeline has a note saying so.
- **Changes to settings** (parcel size, ship-from address) apply to new quotes. Rates already cached
  stay for up to 10 minutes.

## Develop

```bash
pnpm install
pnpm test
pnpm build
```

The tests run the plugin against a fake Shippo API. The plugin API it builds on is
[@spindlecommerce/plugin-sdk](https://www.npmjs.com/package/@spindlecommerce/plugin-sdk).

## Release

Each version is staged on npm and goes live when a maintainer approves it.

1. Raise `version` in `package.json` and in `src/index.ts`. A test checks they match.
2. Commit, then tag and push: for example `git tag v1.0.1 && git push origin main v1.0.1`.
3. The Release workflow tests, builds and stages the version, and creates the GitHub release.
4. Approve it on npmjs.com, under **Staged Packages**, with 2FA.

The workflow publishes with npm's trusted publishing, so it needs no token. Before its first release,
a maintainer links the package to the workflow:

```bash
npm trust github @spindlecommerce/plugin-shippo --repo spindlecommerce/plugin-shippo --file release.yml --allow-stage-publish
```

Run it just before tagging: npm drops a link that isn't used within 48 hours.

## License

MIT
