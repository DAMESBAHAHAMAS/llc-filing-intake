import { Router } from "express";
import { einPortalConfig, portalUrlFor, type EinPortalConfig } from "../ein/onboarding.js";

/**
 * ST17: GET /api/onboarding/ein tells the website's /onboarding/ein page where the
 * Zoho CRM Portal is. It takes no input and returns no customer data: the portal is
 * the same for every customer, who signs in with the invitation Zoho emails them.
 * 503 "not_open" until EIN_ONBOARDING_ENABLED=true and EIN_PORTAL_URL is set, so
 * the page shows "opens soon".
 */
export function createEinOnboardingRouter(config: () => EinPortalConfig = () => einPortalConfig()): Router {
  const router = Router();
  router.get("/api/onboarding/ein", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const portalUrl = portalUrlFor(config());
    if (!portalUrl) {
      res.status(503).json({ error: "not_open" });
      return;
    }
    res.status(200).json({ status: "open", portal_url: portalUrl });
  });
  return router;
}

export const einOnboardingRouter = createEinOnboardingRouter();
