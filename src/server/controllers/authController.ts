import type { Request, Response } from 'express';
import { extractToken, setAuthCookie } from '../auth.ts';
import { authService } from '../services/authService.ts';
import { handleControllerError } from '../services/errors.ts';

export function resolveSafeBaseUrl(req: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  const rawHost = String(req.get('x-forwarded-host') || req.get('host') || '').trim();
  const safeHost = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(rawHost)
    ? rawHost
    : 'localhost:3000';
  const proto =
    req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return `${proto}://${safeHost}`;
}

export const authController = {
  async login(req: Request, res: Response) {
    try {
      const userAgent = String(req.headers['user-agent'] || '');
      const result = await authService.login(req.body || {}, userAgent);

      setAuthCookie(req, res, result.token);

      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur lors de la connexion.');
    }
  },

  async registerRestaurant(req: Request, res: Response) {
    try {
      const userAgent = String(req.headers['user-agent'] || '');
      const baseUrl = resolveSafeBaseUrl(req);
      const result = await authService.registerRestaurant(
        req.body || {},
        userAgent,
        baseUrl,
      );

      setAuthCookie(req, res, result.token);

      res.status(201).json(result);
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur lors de la création du restaurant.',
      );
    }
  },

  async me(req: Request, res: Response) {
    try {
      const token = extractToken(req);
      const user = await authService.getMe(token);
      res.json({ user });
    } catch (err) {
      handleControllerError(res, err, 'Erreur vérification session.');
    }
  },

  async logout(req: Request, res: Response) {
    try {
      await authService.logout(req.auth);
      res.clearCookie('restomax_token', { path: '/' });
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur déconnexion.');
    }
  },

  async changePassword(req: Request, res: Response) {
    try {
      await authService.changePassword(req.auth!, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur changement de mot de passe.');
    }
  },

  async forgotPassword(req: Request, res: Response) {
    try {
      const baseUrl = resolveSafeBaseUrl(req);
      const result = await authService.forgotPassword(req.body || {}, baseUrl);
      res.json(result);
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur lors de la demande de réinitialisation.',
      );
    }
  },

  async validateResetToken(req: Request, res: Response) {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const result = await authService.validateResetToken(token);
      res.json(result);
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur lors de la vérification du jeton.',
      );
    }
  },

  async resetPassword(req: Request, res: Response) {
    try {
      await authService.resetPassword(req.body || {});
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur lors de la réinitialisation du mot de passe.',
      );
    }
  },

  async sendVerification(req: Request, res: Response) {
    try {
      const baseUrl = resolveSafeBaseUrl(req);
      const result = await authService.sendVerificationEmail(
        req.auth!,
        baseUrl,
      );
      res.json(result);
    } catch (err) {
      handleControllerError(
        res,
        err,
        'Erreur envoi lien de vérification e-mail.',
      );
    }
  },

  async verifyEmail(req: Request, res: Response) {
    try {
      const result = await authService.verifyEmail(req.body || {});
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur vérification e-mail.');
    }
  },

  async setPin(req: Request, res: Response) {
    try {
      await authService.setPin(req.auth!, req.body || {});
      res.json({ ok: true });
    } catch (err) {
      handleControllerError(res, err, 'Erreur configuration code PIN.');
    }
  },

  async pinLogin(req: Request, res: Response) {
    try {
      const userAgent = String(req.headers['user-agent'] || '');
      const result = await authService.pinLogin(
        req.body || {},
        userAgent,
        req.auth?.restaurantId || null,
      );

      setAuthCookie(req, res, result.token);

      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur connexion par code PIN.');
    }
  },

  async getVenues(req: Request, res: Response) {
    try {
      const venues = await authService.getUserVenues(req.auth!);
      res.json({ venues });
    } catch (err) {
      handleControllerError(res, err, 'Erreur chargement établissements.');
    }
  },

  async switchVenue(req: Request, res: Response) {
    try {
      const result = await authService.switchVenue(
        req.auth!,
        String(req.body?.restaurantId || ''),
      );
      res.json(result);
    } catch (err) {
      handleControllerError(res, err, 'Erreur changement d’établissement.');
    }
  },
};
