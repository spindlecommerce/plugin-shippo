import { readFile } from "node:fs/promises";
import type { PluginContext, RateRequest, ShipmentRequest } from "@spindlecommerce/plugin-sdk";
import { describe, expect, it } from "vitest";
import { shippo } from "../src/index.ts";
import { checkConnection, shippoProvider, toMinorUnits, trackingUrl, type ShippoRate, type ShippoSettings } from "../src/provider.ts";

const TOKEN = "shippo_test_abc123";
const ADDRESS = { firstName: "Ana", lastName: "Silva", line1: "1 Broad St", city: "New York", regionCode: "NY", postalCode: "10004", countryCode: "US" };
const WAREHOUSE = { company: "Trail Co", line1: "200 Dock St", city: "Newark", regionCode: "NJ", postalCode: "07102", countryCode: "US" };

const RATES: ShippoRate[] = [
  { object_id: "rate_prio", amount: "7.58", currency: "USD", provider: "USPS", servicelevel: { name: "Priority Mail", token: "usps_priority" }, estimated_days: 2 },
  { object_id: "rate_ground_adv", amount: "5.20", currency: "USD", provider: "USPS", servicelevel: { name: "Ground Advantage", token: "usps_ground_advantage" }, estimated_days: 5 },
  { object_id: "rate_ups_2", amount: "11.00", currency: "USD", provider: "UPS", servicelevel: { name: "UPS Ground", token: "ups_ground" }, estimated_days: 3 },
  // A second UPS account quotes the same service: the cheaper one is offered.
  { object_id: "rate_ups_1", amount: "9.99", currency: "USD", provider: "UPS", servicelevel: { name: "UPS Ground", token: "ups_ground" }, estimated_days: 3 },
  { object_id: "rate_dhl", amount: "30.00", currency: "EUR", provider: "DHL Express", servicelevel: { name: "Express Worldwide", token: "dhl_express_worldwide" }, estimated_days: null },
];

type Call = { method: string; url: string; authorization: string | null; body: any };

/** Shippo's API as far as the plugin uses it. */
const fakeShippo = () => {
  const calls: Call[] = [];
  const state = { rates: RATES, transactionStatus: "SUCCESS", shipmentStatus: 201 };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, authorization, body });
    if (authorization !== `ShippoToken ${TOKEN}`) return json(401, { detail: "Invalid token." });
    if (method === "POST" && url === "https://api.goshippo.com/shipments/") {
      if (state.shipmentStatus !== 201) return json(state.shipmentStatus, { address_to: ["This field is required."] });
      return json(201, { object_id: `shp_${calls.length}`, status: "SUCCESS", rates: state.rates, messages: state.rates.length ? [] : [{ source: "UPS", text: "Address not served" }] });
    }
    if (method === "POST" && url === "https://api.goshippo.com/transactions/") {
      if (state.transactionStatus !== "SUCCESS") return json(201, { object_id: "tx_err", status: state.transactionStatus, messages: [{ text: "The carrier account is suspended" }] });
      return json(201, {
        object_id: `tx_${body.rate}`,
        status: "SUCCESS",
        tracking_number: "9400111899223197428490",
        tracking_url_provider: "https://tools.usps.com/go/TrackConfirmAction_input?origTrackNum=9400111899223197428490",
        label_url: `https://deliver.goshippo.com/${body.rate}.pdf`,
        test: true,
      });
    }
    if (method === "GET" && url.startsWith("https://api.goshippo.com/carrier_accounts/")) {
      return json(200, { results: [{ carrier: "usps", active: true }, { carrier: "ups", active: true }, { carrier: "fedex", active: false }] });
    }
    return json(404, { detail: "Not found." });
  };
  return { fetch, calls, state };
};

const quiet = () => {};
/** A logger that says nothing. */
const silent = { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet, fatal: quiet };

/** A plugin context built by hand, as the runtime would. */
const contextFor = (fetch: typeof globalThis.fetch, settings: Partial<PluginContext<ShippoSettings>["settings"]> = {}) =>
  ({
    plugin: { name: "shippo", version: "1.0.0" },
    settings: { apiToken: TOKEN, parcelLength: 30, parcelWidth: 20, parcelHeight: 10, labelFileType: "PDF_4x6", ...settings },
    fetch,
    logger: silent,
  }) as unknown as PluginContext<ShippoSettings>;

const rateRequest = (overrides: Partial<RateRequest> = {}): RateRequest => ({
  method: { id: "m1", code: "us_live", name: "Carrier rates", options: {} },
  channelId: "c1",
  locale: "en-US",
  currency: "USD",
  subtotal: 7000,
  weightGrams: 1200,
  quantity: 3,
  destination: ADDRESS,
  origin: WAREHOUSE,
  lines: [{ sku: "TOTE-BLACK", name: "Tote", quantity: 3, weightGrams: 400, unitPrice: 3500 }],
  ...overrides,
});

describe("Shippo rates", () => {
  it("quotes one parcel of the default size and maps rates in the cart's currency", async () => {
    const api = fakeShippo();
    const quotes = await shippoProvider.rates(rateRequest(), contextFor(api.fetch));
    expect(api.calls).toEqual([
      {
        method: "POST",
        url: "https://api.goshippo.com/shipments/",
        authorization: `ShippoToken ${TOKEN}`,
        body: {
          address_from: { name: "Trail Co", company: "Trail Co", street1: "200 Dock St", city: "Newark", state: "NJ", zip: "07102", country: "US" },
          address_to: { name: "Ana Silva", street1: "1 Broad St", city: "New York", state: "NY", zip: "10004", country: "US" },
          parcels: [{ length: "30", width: "20", height: "10", distance_unit: "cm", weight: "1200", mass_unit: "g" }],
          async: false,
        },
      },
    ]);
    expect(quotes).toEqual([
      { code: "usps:usps_ground_advantage", name: "USPS Ground Advantage", amount: 520, carrier: "USPS", minDeliveryDays: 5, maxDeliveryDays: 5, data: { rateId: "rate_ground_adv", provider: "USPS", servicelevel: "usps_ground_advantage" } },
      { code: "usps:usps_priority", name: "USPS Priority Mail", amount: 758, carrier: "USPS", minDeliveryDays: 2, maxDeliveryDays: 2, data: { rateId: "rate_prio", provider: "USPS", servicelevel: "usps_priority" } },
      { code: "ups:ups_ground", name: "UPS Ground", amount: 999, carrier: "UPS", minDeliveryDays: 3, maxDeliveryDays: 3, data: { rateId: "rate_ups_1", provider: "UPS", servicelevel: "ups_ground" } },
    ]);
    const euro = await shippoProvider.rates(rateRequest({ currency: "EUR" }), contextFor(api.fetch));
    expect(euro).toEqual([expect.objectContaining({ code: "dhl_express:dhl_express_worldwide", amount: 3000, minDeliveryDays: null })]);
  });

  it("applies the method's carriers, service levels, markup and handling fee", async () => {
    const api = fakeShippo();
    const options = { carriers: "ups, Usps", serviceLevels: "usps_priority, UPS_GROUND", markupPercent: 10, handlingFee: 150 };
    const quotes = await shippoProvider.rates(rateRequest({ method: { id: "m1", code: "us_live", name: "Carrier rates", options } }), contextFor(api.fetch));
    // 7.58 + 10% = 8.338 → 8.34, + 1.50; 9.99 + 10% = 10.989 → 10.99, + 1.50.
    expect(quotes.map((q) => [q.code, q.amount])).toEqual([
      ["usps:usps_priority", 984],
      ["ups:ups_ground", 1249],
    ]);
    const upsOnly = await shippoProvider.rates(rateRequest({ method: { id: "m1", code: "us_live", name: "Carrier rates", options: { carriers: "UPS" } } }), contextFor(api.fetch));
    expect(upsOnly.map((q) => q.code)).toEqual(["ups:ups_ground"]);
  });

  it("ships from the settings' address when it has a street, and needs one or the other", async () => {
    const api = fakeShippo();
    const settings = { originName: "Trail Co Returns", originStreet: "5 Pier Rd", originCity: "Hoboken", originState: "NJ", originPostalCode: "07030", originCountry: "us", originPhone: "+1 201 555 0100" };
    await shippoProvider.rates(rateRequest({ origin: null }), contextFor(api.fetch, settings));
    expect(api.calls[0]!.body.address_from).toEqual({ name: "Trail Co Returns", street1: "5 Pier Rd", city: "Hoboken", state: "NJ", zip: "07030", country: "US", phone: "+1 201 555 0100" });
    await expect(shippoProvider.rates(rateRequest({ origin: null }), contextFor(api.fetch))).rejects.toThrow("No ship-from address");
    await expect(shippoProvider.rates(rateRequest(), contextFor(api.fetch, { apiToken: "shippo_test_wrong" }))).rejects.toThrow("Shippo answered 401: Invalid token.");
    api.state.shipmentStatus = 400;
    await expect(shippoProvider.rates(rateRequest(), contextFor(api.fetch))).rejects.toThrow("Shippo answered 400: address_to: This field is required.");
  });
});

describe("Shippo labels", () => {
  const order = (shippingMethod: ShipmentRequest["order"]["shippingMethod"]) =>
    ({
      id: "o1",
      number: "US-000001",
      email: "ana@example.test",
      currency: "USD",
      shippingAddress: ADDRESS,
      shippingMethod,
    }) as ShipmentRequest["order"];
  const shipment = (overrides: Partial<ShipmentRequest> = {}): ShipmentRequest => ({
    order: order(null),
    lines: [{ orderLineId: "l1", sku: "TOTE-BLACK", name: "Tote", quantity: 2, weightGrams: 400 }],
    origin: WAREHOUSE,
    method: null,
    rate: null,
    ...overrides,
  });
  const chosen = { provider: "shippo", method: "us_live", rate: "usps:usps_priority", data: { rateId: "rate_old", provider: "USPS", servicelevel: "usps_priority" } };

  it("re-quotes the shipment and buys the label for the service the customer chose", async () => {
    const api = fakeShippo();
    const result = await shippoProvider.createShipment!(shipment({ method: { code: "us_live", options: {} }, rate: chosen }), contextFor(api.fetch, { labelFileType: "ZPLII" }));
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://api.goshippo.com/shipments/", "POST https://api.goshippo.com/transactions/"]);
    expect(api.calls[0]!.body).toMatchObject({ address_to: { name: "Ana Silva", email: "ana@example.test" }, parcels: [{ weight: "800", mass_unit: "g" }] });
    expect(api.calls[1]!.body).toEqual({ rate: "rate_prio", label_file_type: "ZPLII", async: false });
    expect(result).toEqual({
      tracking: [{ carrier: "USPS", number: "9400111899223197428490", url: "https://tools.usps.com/go/TrackConfirmAction_input?origTrackNum=9400111899223197428490" }],
      labelUrl: "https://deliver.goshippo.com/rate_prio.pdf",
      cost: { amount: 758, currency: "USD" },
      data: { transactionId: "tx_rate_prio", rateId: "rate_prio", shipmentId: expect.stringMatching(/^shp_/), provider: "USPS", servicelevel: "usps_priority", test: true },
    });
  });

  it("buys the cheapest label for orders that did not use Shippo, and reports what went wrong", async () => {
    const api = fakeShippo();
    const cheapest = await shippoProvider.createShipment!(shipment(), contextFor(api.fetch));
    expect(api.calls[1]!.body.rate).toBe("rate_ground_adv");
    expect(cheapest.cost).toEqual({ amount: 520, currency: "USD" });

    api.state.rates = RATES.filter((r) => r.servicelevel.token !== "usps_priority");
    await expect(shippoProvider.createShipment!(shipment({ rate: chosen }), contextFor(api.fetch))).rejects.toThrow("Shippo offers no usps_priority rate for this shipment now");
    api.state.rates = RATES;
    api.state.transactionStatus = "ERROR";
    await expect(shippoProvider.createShipment!(shipment({ rate: chosen }), contextFor(api.fetch))).rejects.toThrow("the label was not created (The carrier account is suspended)");
  });

  it("links tracking numbers of common carriers", () => {
    expect(trackingUrl({ carrier: "USPS", number: "9400 1118" })).toBe("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201118");
    expect(trackingUrl({ carrier: "ups", number: "1Z999" })).toBe("https://www.ups.com/track?tracknum=1Z999");
    expect(trackingUrl({ carrier: "FedEx", number: "7700" })).toBe("https://www.fedex.com/fedextrack/?trknbr=7700");
    expect(trackingUrl({ carrier: "DHL Express", number: "123" })).toContain("tracking-id=123");
    expect(trackingUrl({ carrier: "Pigeon Post", number: "1" })).toBeNull();
  });

  it("tests the connection and says whether the token is a test token", async () => {
    const api = fakeShippo();
    expect(await checkConnection(contextFor(api.fetch))).toEqual({ ok: true, message: "Connected with a test token: rates are real, labels are free samples. Carriers: usps, ups." });
    expect(api.calls[0]).toMatchObject({ method: "GET", url: "https://api.goshippo.com/carrier_accounts/?results=100" });
    expect(await checkConnection(contextFor(api.fetch, { apiToken: "shippo_live_nope" }))).toEqual({ ok: false, message: "Shippo rejected the API token." });
  });
});

describe("The plugin", () => {
  it("offers the shippo shipping provider and a connection check, for plugin API 1", () => {
    const plugin = shippo();
    expect(plugin).toMatchObject({ name: "shippo", apiVersion: 1, title: "Shippo" });
    expect(plugin.shipping?.map((provider) => provider.code)).toEqual(["shippo"]);
    expect(plugin.check).toBe(checkConnection);
  });

  it("reports the package's version", async () => {
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(shippo().version).toBe(version);
  });
});

describe("Amounts", () => {
  it("use the platform's minor units for every currency", () => {
    expect([toMinorUnits("5.50", "USD"), toMinorUnits("1500", "JPY"), toMinorUnits("1.234", "KWD"), toMinorUnits("1500", "HUF")]).toEqual([550, 1500, 1234, 150_000]);
  });
});
