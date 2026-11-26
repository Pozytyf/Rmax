import type { Request, Response } from 'express';
import { publicService } from '../services/publicService.ts';
import { handleControllerError } from '../services/errors.ts';

export const publicController = {
  async getPlans(_req: Request, res: Response) {
    try {
      const plans = await publicService.getActivePlans();
      res.json({ plans });
    } catch (err) {
      handleControllerError(res, err, 'Erreur lors du chargement des offres.');
    }
  },

  async getSettings(_req: Request, res: Response) {
    try {
      const settings = await publicService.getPlatformSettings();
      res.json({ settings });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement paramètres.');
    }
  },

  async submitContact(req: Request, res: Response) {
    try {
      const result = await publicService.submitContactLead(req.body || {});
      if (result.honeypot) {
        res.status(200).json({ ok: true });
        return;
      }
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur lors de l’envoi du message.');
    }
  },

  async submitDemoRequest(req: Request, res: Response) {
    try {
      const result = await publicService.submitDemoRequest(req.body || {});
      if (result.honeypot) {
        res.status(200).json({ ok: true });
        return;
      }
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur lors de l’enregistrement de la demande.',
      );
    }
  },

  async getQrImage(req: Request, res: Response) {
    try {
      const token = String(req.params.token);
      const host = req.get('host');
      const baseUrl = host
        ? `${req.protocol}://${host}`
        : process.env.APP_URL || 'http://localhost:3000';
      const svg = await publicService.generateQrSvg(token, baseUrl);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (err) {
      handleControllerError(res, err, 'Impossible de générer le QR code.');
    }
  },

  async getQrMenuContext(req: Request, res: Response) {
    try {
      const context = await publicService.getQrMenuContext(String(req.params.token));
      res.json(context);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement menu QR.');
    }
  },

  async lookupQrLoyalty(req: Request, res: Response) {
    try {
      const info = await publicService.lookupPublicLoyaltyByQr(
        String(req.params.token),
        String(req.query.phone || ''),
      );
      res.json(info);
    } catch (err) {
      handleControllerError(res, err, 'Erreur vérification fidélité.');
    }
  },

  async submitQrOrder(req: Request, res: Response) {
    try {
      const result = await publicService.submitQrOrder(
        String(req.params.token),
        req.body || {},
      );
      if (result.deduplicated) {
        res.status(200).json({ order: result.order, deduplicated: true });
        return;
      }
      res.status(201).json({ order: result.order });
    } catch (err) {
      handleControllerError(res, err, 'Erreur lors de l’envoi de la commande.');
    }
  },

  async trackQrOrder(req: Request, res: Response) {
    try {
      const order = await publicService.trackQrOrder(
        String(req.params.token),
        String(req.params.orderId),
      );
      res.json({ order });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suivi de commande.');
    }
  },

  payQrOrder(req: Request, res: Response) {
    try {
      const result = publicService.payQrOrder(
        String(req.params.token),
        String(req.params.orderId),
        req.body || {},
      );
      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur lors du paiement en ligne.');
    }
  },

  callWaiterOrBill(req: Request, res: Response) {
    try {
      const result = publicService.callWaiterOrBill(
        String(req.params.token),
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur appel serveur.');
    }
  },

  submitQrReview(req: Request, res: Response) {
    try {
      const result = publicService.submitQrReview(
        String(req.params.token),
        String(req.params.orderId),
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur enregistrement avis.');
    }
  },

  submitQrServiceRating(req: Request, res: Response) {
    try {
      const result = publicService.submitQrServiceRating(
        String(req.params.token),
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur enregistrement note de service.');
    }
  },

  // ── Storefront (Click & Collect & Livraison) ────────────────────────────
  async getStorefrontContext(req: Request, res: Response) {
    try {
      const ctx = await publicService.getStorefrontContext(String(req.params.slug));
      res.json(ctx);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement boutique en ligne.');
    }
  },

  async lookupStorefrontLoyalty(req: Request, res: Response) {
    try {
      const info = await publicService.lookupPublicLoyaltyBySlug(
        String(req.params.slug),
        String(req.query.phone || ''),
      );
      res.json(info);
    } catch (err) {
      handleControllerError(res, err, 'Erreur vérification fidélité.');
    }
  },

  async submitStorefrontOrder(req: Request, res: Response) {
    try {
      const result = await publicService.submitStorefrontOrder(
        String(req.params.slug),
        req.body || {},
      );
      if (result.deduplicated) {
        res.status(200).json(result);
        return;
      }
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur lors de l’envoi de votre commande en ligne.',
      );
    }
  },

  async trackStorefrontOrder(req: Request, res: Response) {
    try {
      const order = await publicService.trackStorefrontOrder(
        String(req.params.slug),
        String(req.params.orderId),
      );
      res.json({ order });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suivi commande.');
    }
  },

  payStorefrontOrder(req: Request, res: Response) {
    try {
      const result = publicService.payStorefrontOrder(
        String(req.params.slug),
        String(req.params.orderId),
        req.body || {},
      );
      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur paiement commande en ligne.');
    }
  },

  submitStorefrontReview(req: Request, res: Response) {
    try {
      const result = publicService.submitStorefrontReview(
        String(req.params.slug),
        String(req.params.orderId),
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur enregistrement avis.');
    }
  },

  submitStorefrontServiceRating(req: Request, res: Response) {
    try {
      const result = publicService.submitStorefrontServiceRating(
        String(req.params.slug),
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur enregistrement note de service.');
    }
  },

  handlePaydunyaWebhook(req: Request, res: Response) {
    try {
      const sigHeader = req.get('x-paydunya-signature') || undefined;
      const result = publicService.handlePaydunyaSubscriptionWebhook(
        (req.body || {}) as Record<string, unknown>,
        sigHeader,
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur webhook PayDunya.');
    }
  },
};
