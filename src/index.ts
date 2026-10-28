import { definePlugin } from "@spindlecommerce/plugin-sdk";
import { checkConnection, shippoProvider, shippoSettings } from "./provider.ts";

/**
 * Shippo (goshippo.com): live carrier rates at checkout for shipping methods that use the "shippo"
 * provider, and labels bought when staff fulfil an order. See README.md.
 */
export const shippo = () =>
  definePlugin({
    name: "shippo",
    // The package's version (a test keeps them equal), shown in the admin.
    version: "1.0.0",
    // The plugin API this was written for, as a number: PLUGIN_API_VERSION would be the
    // installation's own, so it would always match.
    apiVersion: 1,
    title: "Shippo",
    description: "Live rates from USPS, UPS, FedEx, DHL and more at checkout, and shipping labels when you fulfil orders.",
    settings: shippoSettings,
    shipping: [shippoProvider],
    check: checkConnection,
  });

export default shippo;
