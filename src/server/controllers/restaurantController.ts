import type { Request, Response } from 'express';
import { setAuthCookie } from '../auth.ts';
import { authService } from '../services/authService.ts';
import { restaurantService } from '../services/restaurantService.ts';
import { handleControllerError } from '../services/errors.ts';

export const restaurantController = {
  getDashboard(req: Request, res: Response) {
    try {
      const data = restaurantService.getDashboard(req.auth!.restaurantId!);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement dashboard.');
    }
  },

  async getMenu(req: Request, res: Response) {
    try {
      const menu = await restaurantService.getMenu(req.auth!.restaurantId!);
      res.json(menu);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement menu.');
    }
  },

  async createCategory(req: Request, res: Response) {
    try {
      const category = await restaurantService.createCategory(
        req.auth!.restaurantId!,
        req.body || {},
      );
      res.status(201).json({ category });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création catégorie.');
    }
  },

  async updateCategory(req: Request, res: Response) {
    try {
      await restaurantService.updateCategory(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour catégorie.');
    }
  },

  async deleteCategory(req: Request, res: Response) {
    try {
      await restaurantService.deleteCategory(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression catégorie.');
    }
  },

  async createMenuItem(req: Request, res: Response) {
    try {
      const id = await restaurantService.createMenuItem(req.auth!, req.body || {});
      res.status(201).json({ id });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création article.');
    }
  },

  async updateMenuItem(req: Request, res: Response) {
    try {
      await restaurantService.updateMenuItem(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour article.');
    }
  },

  async deleteMenuItem(req: Request, res: Response) {
    try {
      await restaurantService.deleteMenuItem(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression article.');
    }
  },

  async getRecipes(req: Request, res: Response) {
    try {
      const menuItemId =
        typeof req.query.menuItemId === 'string' ? req.query.menuItemId : undefined;
      const recipes = await restaurantService.getRecipes(
        req.auth!.restaurantId!,
        menuItemId,
      );
      res.json({ recipes });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement fiches techniques.');
    }
  },

  async updateMenuItemRecipe(req: Request, res: Response) {
    try {
      const recipes = await restaurantService.updateMenuItemRecipe(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ recipes });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour fiche technique.');
    }
  },

  getOrders(req: Request, res: Response) {
    try {
      const orders = restaurantService.getOrders(req.auth!.restaurantId!);
      res.json({ orders });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement commandes.');
    }
  },

  async createPosOrder(req: Request, res: Response) {
    try {
      const result = await restaurantService.createPosOrder(
        req.auth!,
        req.body || {},
      );
      if (result.deduplicated) {
        res.status(200).json({ order: result.order, deduplicated: true });
        return;
      }
      res.status(201).json({ order: result.order });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création commande.');
    }
  },

  updateOrderStatus(req: Request, res: Response) {
    try {
      restaurantService.updateOrderStatus(
        req.auth!,
        String(req.params.id),
        req.body?.status,
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour commande.');
    }
  },

  getPayments(req: Request, res: Response) {
    try {
      const payments = restaurantService.getPayments(req.auth!.restaurantId!);
      res.json({ payments });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement paiements.');
    }
  },

  payOrder(req: Request, res: Response) {
    try {
      const result = restaurantService.payOrder(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      if (result.deduplicated) {
        res.status(200).json({ payment: result.payment, deduplicated: true });
        return;
      }
      const isFullyPaid = Boolean(
        result.payments?.some((p) => p.fullyPaid) ??
          (result.payment as { fullyPaid?: boolean } | undefined)?.fullyPaid,
      );
      res.status(201).json({
        payment: result.payment,
        payments: result.payments,
        fullyPaid: isFullyPaid,
        pointsEarned: result.pointsEarned ?? 0,
      });
    } catch (err) {
      handleControllerError(res, err, 'Erreur lors de l’encaissement.');
    }
  },

  refundPayment(req: Request, res: Response) {
    try {
      restaurantService.refundPayment(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur remboursement.');
    }
  },

  getTables(req: Request, res: Response) {
    try {
      const tables = restaurantService.getTables(req.auth!.restaurantId!);
      res.json({ tables });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement tables.');
    }
  },

  createTable(req: Request, res: Response) {
    try {
      const result = restaurantService.createTable(
        req.auth!.restaurantId!,
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création table.');
    }
  },

  updateTable(req: Request, res: Response) {
    try {
      restaurantService.updateTable(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur modification table.');
    }
  },

  deleteTable(req: Request, res: Response) {
    try {
      restaurantService.deleteTable(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression table.');
    }
  },

  transferTable(req: Request, res: Response) {
    try {
      restaurantService.transferTable(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur transfert de table.');
    }
  },

  mergeTables(req: Request, res: Response) {
    try {
      restaurantService.mergeTables(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur fusion de tables.');
    }
  },

  updateTableStatus(req: Request, res: Response) {
    try {
      restaurantService.updateTableStatus(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body?.status,
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour table.');
    }
  },

  regenerateTableQr(req: Request, res: Response) {
    try {
      const result = restaurantService.regenerateTableQr(
        req.auth!,
        String(req.params.id),
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur régénération QR.');
    }
  },

  getStocks(req: Request, res: Response) {
    try {
      const data = restaurantService.getStocks(req.auth!.restaurantId!);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement stocks.');
    }
  },

  async createStockItem(req: Request, res: Response) {
    try {
      const id = await restaurantService.createStockItem(
        req.auth!,
        req.body || {},
      );
      res.status(201).json({ id });
    } catch (err) {
      handleControllerError(res, err, 'Erreur ajout ingrédient.');
    }
  },

  updateStockItem(req: Request, res: Response) {
    try {
      restaurantService.updateStockItem(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur modification ingrédient.');
    }
  },

  deleteStockItem(req: Request, res: Response) {
    try {
      restaurantService.deleteStockItem(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression ingrédient.');
    }
  },

  getPurchaseOrders(req: Request, res: Response) {
    try {
      const purchaseOrders = restaurantService.getPurchaseOrders(
        req.auth!.restaurantId!,
      );
      res.json({ purchaseOrders });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement bons de commande.');
    }
  },

  createPurchaseOrder(req: Request, res: Response) {
    try {
      const result = restaurantService.createPurchaseOrder(
        req.auth!,
        req.body || {},
      );
      res.status(201).json({ purchaseOrder: result });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création bon de commande.');
    }
  },

  updatePurchaseOrderStatus(req: Request, res: Response) {
    try {
      restaurantService.updatePurchaseOrderStatus(
        req.auth!,
        String(req.params.id),
        req.body?.status,
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour bon de commande.');
    }
  },

  async moveStock(req: Request, res: Response) {
    try {
      const result = await restaurantService.moveStock(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur mouvement stock.');
    }
  },

  getStockAlertConfig(req: Request, res: Response) {
    try {
      const data = restaurantService.getStockAlertConfig(
        req.auth!.restaurantId!,
      );
      res.json(data);
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur chargement configuration alertes stock.',
      );
    }
  },

  updateStockAlertConfig(req: Request, res: Response) {
    try {
      const settings = restaurantService.updateStockAlertConfig(
        req.auth!,
        req.body || {},
      );
      res.json({ settings });
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur mise à jour configuration alertes stock.',
      );
    }
  },

  async triggerManualStockAlert(req: Request, res: Response) {
    try {
      const result = await restaurantService.triggerManualStockAlert(
        req.auth!,
        String(req.params.id),
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur envoi alerte stock.');
    }
  },

  async testStockAlertEmail(req: Request, res: Response) {
    try {
      const result = await restaurantService.testStockAlertEmail(req.auth!);
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur test SMTP.');
    }
  },

  getNotifications(req: Request, res: Response) {
    try {
      const data = restaurantService.getNotifications(req.auth!.restaurantId!);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement notifications.');
    }
  },

  markNotificationsRead(req: Request, res: Response) {
    try {
      restaurantService.markNotificationsRead(
        req.auth!.restaurantId!,
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour notifications.');
    }
  },

  getStaff(req: Request, res: Response) {
    try {
      const data = restaurantService.getStaff(req.auth!.restaurantId!);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement équipe.');
    }
  },

  getPinDirectory(req: Request, res: Response) {
    try {
      const directory = restaurantService.getPinDirectory(req.auth!.restaurantId!);
      res.json({ directory });
    } catch (err) {
      handleControllerError(res, err, 'Erreur annuaire PIN.');
    }
  },

  getPosPinOperators(req: Request, res: Response) {
    try {
      const operators = restaurantService.getPosPinOperators(req.auth!.restaurantId!);
      res.json({ operators });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement opérateurs POS.');
    }
  },

  async posPinSwitch(req: Request, res: Response) {
    try {
      const userAgent = String(req.headers['user-agent'] || '');
      const result = await authService.pinLogin(
        req.body || {},
        userAgent,
        req.auth!.restaurantId!,
        { allowedRoles: ['WAITER', 'CASHIER', 'MANAGER', 'OWNER'] },
      );
      setAuthCookie(req, res, result.token);
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur bascule rapide POS par code PIN.');
    }
  },

  createStaff(req: Request, res: Response) {
    try {
      const result = restaurantService.createStaff(req.auth!, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création employé.');
    }
  },

  updateStaff(req: Request, res: Response) {
    try {
      restaurantService.updateStaff(
        req.auth!,
        String(req.params.memberId),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour employé.');
    }
  },

  deleteStaff(req: Request, res: Response) {
    try {
      restaurantService.deleteStaff(req.auth!, String(req.params.memberId));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression employé.');
    }
  },

  getCustomers(req: Request, res: Response) {
    try {
      const customers = restaurantService.getCustomers(req.auth!.restaurantId!);
      res.json({ customers });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement clients.');
    }
  },

  createCustomer(req: Request, res: Response) {
    try {
      const id = restaurantService.createCustomer(
        req.auth!.restaurantId!,
        req.body || {},
      );
      res.status(201).json({ id });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création client.');
    }
  },

  updateCustomer(req: Request, res: Response) {
    try {
      restaurantService.updateCustomer(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour client.');
    }
  },

  deleteCustomer(req: Request, res: Response) {
    try {
      restaurantService.deleteCustomer(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression client.');
    }
  },

  getReservations(req: Request, res: Response) {
    try {
      const reservations = restaurantService.getReservations(
        req.auth!.restaurantId!,
      );
      res.json({ reservations });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement réservations.');
    }
  },

  async createReservation(req: Request, res: Response) {
    try {
      const result = await restaurantService.createReservation(
        req.auth!.restaurantId!,
        req.body || {},
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur création réservation.');
    }
  },

  updateReservationStatus(req: Request, res: Response) {
    try {
      restaurantService.updateReservationStatus(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body?.status,
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour réservation.');
    }
  },

  async sendReservationWhatsapp(req: Request, res: Response) {
    try {
      const result = await restaurantService.sendReservationWhatsapp(
        req.auth!,
        String(req.params.id),
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur envoi WhatsApp réservation.');
    }
  },

  async sendOrderWhatsappReceipt(req: Request, res: Response) {
    try {
      const result = await restaurantService.sendOrderWhatsappReceipt(
        req.auth!,
        String(req.params.id),
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur envoi reçu WhatsApp.');
    }
  },

  getWhatsappLogs(req: Request, res: Response) {
    try {
      const logs = restaurantService.getWhatsappLogs(req.auth!.restaurantId!);
      res.json({ logs });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement journaux WhatsApp.');
    }
  },

  getFinance(req: Request, res: Response) {
    try {
      const data = restaurantService.getFinanceSummary(req.auth!.restaurantId!);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement finances.');
    }
  },

  createExpense(req: Request, res: Response) {
    try {
      const id = restaurantService.createExpense(
        req.auth!.restaurantId!,
        req.body || {},
      );
      res.status(201).json({ id });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création dépense.');
    }
  },

  updateExpense(req: Request, res: Response) {
    try {
      restaurantService.updateExpense(
        req.auth!.restaurantId!,
        String(req.params.id),
        req.body || {},
      );
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur modification dépense.');
    }
  },

  deleteExpense(req: Request, res: Response) {
    try {
      restaurantService.deleteExpense(req.auth!, String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur suppression dépense.');
    }
  },

  exportOrdersCsv(req: Request, res: Response) {
    try {
      const csv = restaurantService.exportOrdersCsv(req.auth!.restaurantId!);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="rapport-ventes-restomax.csv"',
      );
      res.send(csv);
    } catch (err) {
      handleControllerError(res, err, 'Erreur export CSV.');
    }
  },

  getSettings(req: Request, res: Response) {
    try {
      const data = restaurantService.getSettings(req.auth!.restaurantId!);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement paramètres.');
    }
  },

  updateSettings(req: Request, res: Response) {
    try {
      restaurantService.updateSettings(req.auth!, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour paramètres.');
    }
  },

  getSubscriptionPortal(req: Request, res: Response) {
    try {
      const data = restaurantService.getSubscriptionPortal(req.auth!.restaurantId!);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement portail abonnement.');
    }
  },

  async checkoutSubscription(req: Request, res: Response) {
    try {
      const configuredBase = process.env.APP_URL?.trim();
      const rawHost = String(req.get('x-forwarded-host') || req.get('host') || '').trim();
      const safeHost = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawHost)
        ? rawHost
        : 'localhost:3000';
      const proto =
        req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
      const baseUrl = configuredBase || `${proto}://${safeHost}`;
      const result = await restaurantService.checkoutSubscription(
        req.auth!,
        req.body || {},
        baseUrl,
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur paiement abonnement.');
    }
  },

  async verifySubscription(req: Request, res: Response) {
    try {
      const result = await restaurantService.verifySubscriptionPayment(
        req.auth!,
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur vérification paiement PayDunya.');
    }
  },

  updateAutoRenew(req: Request, res: Response) {
    try {
      const result = restaurantService.updateSubscriptionAutoRenew(
        req.auth!,
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur mise à jour renouvellement automatique.');
    }
  },

  async renewSubscription(req: Request, res: Response) {
    try {
      const configuredBase = process.env.APP_URL?.trim();
      const rawHost = String(req.get('x-forwarded-host') || req.get('host') || '').trim();
      const safeHost = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawHost)
        ? rawHost
        : 'localhost:3000';
      const proto =
        req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
      const baseUrl = configuredBase || `${proto}://${safeHost}`;
      const result = await restaurantService.renewSubscriptionNow(
        req.auth!,
        req.body || {},
        baseUrl,
      );
      res.status(201).json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur renouvellement abonnement.');
    }
  },

  async printEscposTicket(req: Request, res: Response) {
    try {
      const result = await restaurantService.printEscposTicket(
        req.auth!,
        req.body || {},
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur impression thermique ESC/POS.');
    }
  },

  getTickets(req: Request, res: Response) {
    try {
      const tickets = restaurantService.getTickets(req.auth!.restaurantId!);
      res.json({ tickets });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement tickets.');
    }
  },

  createTicket(req: Request, res: Response) {
    try {
      const id = restaurantService.createTicket(req.auth!, req.body || {});
      res.status(201).json({ id });
    } catch (err) {
      handleControllerError(res, err, 'Erreur création ticket.');
    }
  },
};
