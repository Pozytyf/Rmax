import type { Request, Response } from 'express';
import { operationsService } from '../services/operationsService.ts';
import { handleControllerError } from '../services/errors.ts';

export const operationsController = {
  // Combos
  async listCombos(req: Request, res: Response) {
    try {
      res.json({ combos: await operationsService.listCombos(req.auth!.restaurantId!) });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement formules.');
    }
  },
  async createCombo(req: Request, res: Response) {
    try {
      const combo = await operationsService.createCombo(req.auth!, req.body || {});
      res.status(201).json({ combo });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création formule.');
    }
  },
  async updateCombo(req: Request, res: Response) {
    try {
      const combo = await operationsService.updateCombo(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ combo });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour formule.');
    }
  },
  async deleteCombo(req: Request, res: Response) {
    try {
      await operationsService.deleteCombo(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression formule.');
    }
  },

  // Promotions & Happy Hour
  async listPromotions(req: Request, res: Response) {
    try {
      res.json({
        promotions: await operationsService.listPromotions(req.auth!.restaurantId!),
      });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement promotions.');
    }
  },
  async createPromotion(req: Request, res: Response) {
    try {
      const promotion = await operationsService.createPromotion(
        req.auth!,
        req.body || {},
      );
      res.status(201).json({ promotion });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création promotion.');
    }
  },
  async updatePromotion(req: Request, res: Response) {
    try {
      await operationsService.updatePromotion(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour promotion.');
    }
  },
  async deletePromotion(req: Request, res: Response) {
    try {
      await operationsService.deletePromotion(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression promotion.');
    }
  },

  // Cash Register & Z-Reports
  async getRegisterState(req: Request, res: Response) {
    try {
      res.json(await operationsService.getRegisterState(req.auth!.restaurantId!));
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement caisse.');
    }
  },
  async openRegister(req: Request, res: Response) {
    try {
      const session = await operationsService.openRegister(req.auth!, req.body || {});
      res.status(201).json({ session });
    } catch (err) {
      handleControllerError(res, err, 'Erreur ouverture de caisse.');
    }
  },
  async closeRegister(req: Request, res: Response) {
    try {
      const report = await operationsService.closeRegister(req.auth!, req.body || {});
      res.json({ report });
    } catch (err) {
      handleControllerError(res, err, 'Erreur clôture Z.');
    }
  },

  // Table Calls
  async listTableCalls(req: Request, res: Response) {
    try {
      res.json({
        calls: await operationsService.listTableCalls(req.auth!.restaurantId!),
      });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement appels tables.');
    }
  },
  async acknowledgeTableCall(req: Request, res: Response) {
    try {
      await operationsService.acknowledgeTableCall(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur acquittement appel table.');
    }
  },

  // Loyalty
  async getCustomerLoyalty(req: Request, res: Response) {
    try {
      const transactions = await operationsService.getCustomerLoyaltyHistory(
        req.auth!.restaurantId!,
        String(req.params.id),
      );
      res.json({ transactions });
    } catch (err) {
      handleControllerError(res, err, 'Erreur historique fidélité.');
    }
  },
  async adjustCustomerLoyalty(req: Request, res: Response) {
    try {
      const result = await operationsService.adjustCustomerLoyalty(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur ajustement points.');
    }
  },

  // Customer Reviews
  async listReviews(req: Request, res: Response) {
    try {
      res.json(await operationsService.listReviews(req.auth!.restaurantId!));
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement avis clients.');
    }
  },
  async replyReview(req: Request, res: Response) {
    try {
      await operationsService.replyReview(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur réponse avis.');
    }
  },

  // Inventory Counts & Typed Waste
  async listInventoryCounts(req: Request, res: Response) {
    try {
      res.json({
        counts: await operationsService.listInventoryCounts(req.auth!.restaurantId!),
      });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement inventaires.');
    }
  },
  async createInventoryCount(req: Request, res: Response) {
    try {
      const count = await operationsService.createInventoryCount(
        req.auth!,
        req.body || {},
      );
      res.status(201).json({ count });
    } catch (err) {
      handleControllerError(res, err, 'Erreur validation inventaire.');
    }
  },
  async recordWaste(req: Request, res: Response) {
    try {
      const result = await operationsService.recordTypedWaste(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur enregistrement perte.');
    }
  },

  // Shifts & PIN Clock
  async listShiftsAndClocks(req: Request, res: Response) {
    try {
      res.json(await operationsService.listShiftsAndClocks(req.auth!.restaurantId!));
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement planning & pointages.');
    }
  },
  async createShift(req: Request, res: Response) {
    try {
      const shift = await operationsService.createShift(req.auth!, req.body || {});
      res.status(201).json({ shift });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création créneau.');
    }
  },
  async deleteShift(req: Request, res: Response) {
    try {
      await operationsService.deleteShift(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression créneau.');
    }
  },
  async clockWithPin(req: Request, res: Response) {
    try {
      const result = await operationsService.clockWithPin(req.auth!, req.body || {});
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur pointage PIN.');
    }
  },

  // B2B Invoices & Proformas
  async listB2bInvoices(req: Request, res: Response) {
    try {
      res.json({
        documents: await operationsService.listB2bInvoices(req.auth!.restaurantId!),
      });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement factures B2B.');
    }
  },
  async createB2bInvoice(req: Request, res: Response) {
    try {
      const document = await operationsService.createB2bInvoice(
        req.auth!,
        req.body || {},
      );
      res.status(201).json({ document });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création devis / facture B2B.');
    }
  },
  async updateB2bStatus(req: Request, res: Response) {
    try {
      await operationsService.updateB2bInvoiceStatus(
        req.auth!,
        String(req.params.id),
        req.body?.status,
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour document B2B.');
    }
  },
  async convertProforma(req: Request, res: Response) {
    try {
      const result = await operationsService.convertProformaToInvoice(
        req.auth!,
        String(req.params.id),
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur conversion proforma.');
    }
  },

  // Multi-Venue
  async createBranchVenue(req: Request, res: Response) {
    try {
      const venue = operationsService.createBranchVenue(
        req.auth!,
        req.body || {},
      );
      res.status(201).json({ venue });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création établissement.');
    }
  },
  async getConsolidatedOverview(req: Request, res: Response) {
    try {
      res.json(operationsService.getConsolidatedOverview(req.auth!));
    } catch (err) {
      handleControllerError(res, err, 'Erreur vue consolidée multi-sites.');
    }
  },
};
