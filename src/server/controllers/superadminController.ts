import type { Request, Response } from 'express';
import { resolveSafeBaseUrl } from './authController.ts';
import { superadminService } from '../services/superadminService.ts';
import { handleControllerError } from '../services/errors.ts';

export const superadminController = {
  getDashboard(_req: Request, res: Response) {
    try {
      const data = superadminService.getDashboard();
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement dashboard plateforme.');
    }
  },

  listRestaurants(_req: Request, res: Response) {
    try {
      const restaurants = superadminService.listRestaurants();
      res.json({ restaurants });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement restaurants.');
    }
  },

  getRestaurantDetail(req: Request, res: Response) {
    try {
      const detail = superadminService.getRestaurantDetail(String(req.params.id));
      res.json(detail);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement fiche restaurant.');
    }
  },

  async createRestaurant(req: Request, res: Response) {
    try {
      const baseUrl = resolveSafeBaseUrl(req);
      const result = await superadminService.createRestaurant(
        req.auth!,
        req.body || {},
        baseUrl,
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création restaurant.');
    }
  },

  updateRestaurant(req: Request, res: Response) {
    try {
      superadminService.updateRestaurant(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour restaurant.');
    }
  },

  updateRestaurantStatus(req: Request, res: Response) {
    try {
      superadminService.updateRestaurantStatus(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour statut restaurant.');
    }
  },

  listPlans(_req: Request, res: Response) {
    try {
      const plans = superadminService.listPlans();
      res.json({ plans });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement plans.');
    }
  },

  createPlan(req: Request, res: Response) {
    try {
      const result = superadminService.createPlan(req.auth!, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création plan.');
    }
  },

  updatePlan(req: Request, res: Response) {
    try {
      superadminService.updatePlan(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour plan.');
    }
  },

  listSubscriptions(_req: Request, res: Response) {
    try {
      const subscriptions = superadminService.listSubscriptions();
      res.json({ subscriptions });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement abonnements.');
    }
  },

  updateSubscription(req: Request, res: Response) {
    try {
      superadminService.updateSubscription(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour abonnement.');
    }
  },

  listInvoices(_req: Request, res: Response) {
    try {
      const invoices = superadminService.listInvoices();
      res.json({ invoices });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement facturation.');
    }
  },

  createManualInvoice(req: Request, res: Response) {
    try {
      const result = superadminService.createManualInvoice(
        req.auth!,
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création facture manuelle.');
    }
  },

  markInvoicePaid(req: Request, res: Response) {
    try {
      const result = superadminService.markInvoicePaid(
        req.auth!,
        String(req.params.id),
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      handleControllerError(res, err, 'Erreur validation facture.');
    }
  },

  updateInvoiceStatus(req: Request, res: Response) {
    try {
      superadminService.updateInvoiceStatus(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour facture.');
    }
  },

  listUsers(_req: Request, res: Response) {
    try {
      const users = superadminService.listUsers();
      res.json({ users });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement utilisateurs.');
    }
  },

  createSuperAdmin(req: Request, res: Response) {
    try {
      const result = superadminService.createSuperAdmin(
        req.auth!,
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création administrateur.');
    }
  },

  updateUserStatus(req: Request, res: Response) {
    try {
      superadminService.updateUserStatus(
        req.auth!,
        String(req.params.id),
        req.body?.status,
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour utilisateur.');
    }
  },

  revokeUserSessions(req: Request, res: Response) {
    try {
      superadminService.revokeUserSessions(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur révocation sessions.');
    }
  },

  verifyUserEmail(req: Request, res: Response) {
    try {
      superadminService.verifyUserEmail(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur validation e-mail utilisateur.');
    }
  },

  async triggerUserPasswordReset(req: Request, res: Response) {
    try {
      const baseUrl = resolveSafeBaseUrl(req);
      const result = await superadminService.triggerUserPasswordReset(
        req.auth!,
        String(req.params.id),
        baseUrl,
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur envoi lien de réinitialisation.');
    }
  },

  listTickets(_req: Request, res: Response) {
    try {
      const data = superadminService.listTicketsAndLeads();
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement support.');
    }
  },

  createTicket(req: Request, res: Response) {
    try {
      const result = superadminService.createTicket(req.auth!, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création ticket support.');
    }
  },

  replyToTicket(req: Request, res: Response) {
    try {
      superadminService.replyToTicket(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur réponse ticket.');
    }
  },

  updateLead(req: Request, res: Response) {
    try {
      superadminService.updateLead(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour prospect.');
    }
  },

  async convertLead(req: Request, res: Response) {
    try {
      const baseUrl = resolveSafeBaseUrl(req);
      const result = await superadminService.convertLeadToRestaurant(
        req.auth!,
        String(req.params.id),
        req.body || {},
        baseUrl,
      );
      res.status(result.alreadyConverted ? 200 : 201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur conversion prospect.');
    }
  },

  listAuditLogs(req: Request, res: Response) {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const action =
        typeof req.query.action === 'string' ? req.query.action : undefined;
      const targetType =
        typeof req.query.targetType === 'string'
          ? req.query.targetType
          : undefined;
      const restaurantId =
        typeof req.query.restaurantId === 'string'
          ? req.query.restaurantId
          : undefined;
      const from =
        typeof req.query.from === 'string' ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' ? req.query.to : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;

      const data = superadminService.listAuditLogs({
        q,
        action,
        targetType,
        restaurantId,
        from,
        to,
        limit,
        offset,
      });
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement journal audit.');
    }
  },

  async getSettings(_req: Request, res: Response) {
    try {
      const settings = await superadminService.getPlatformSettings();
      res.json({ settings });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement paramètres.');
    }
  },

  async updateSettings(req: Request, res: Response) {
    try {
      await superadminService.updatePlatformSettings(req.auth!, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour paramètres.');
    }
  },

  async testSmtp(req: Request, res: Response) {
    try {
      const result = await superadminService.testPlatformSmtp(
        req.auth!,
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur test SMTP plateforme.');
    }
  },
};
