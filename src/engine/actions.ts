/**
 * @module actions
 */

import type { BotAction } from '../shared/types.js';

/**
 * Parse an input value (string or object) into a typed BotAction.
 *
 * Handles multiple string formats:
 *   'thrust' → { type: 'thrust', angle: 0 }
 *   'rotate-left', 'turn-left' → { type: 'rotate', direction: -1 }
 *   'rotate-right', 'turn-right' → { type: 'rotate', direction: 1 }
 *   'fire', 'shoot' → { type: 'fire' }
 *   'wait', 'pass' → { type: 'wait' }
 *
 * Also handles object inputs with a `type` field (plus optional `angle` and `direction`).
 * Falls back to `{ type: 'wait' }` for unrecognized input.
 *
 * @param input - Raw input from the bot's tick function result
 * @returns The parsed BotAction
 */
export function parseBotAction(input: unknown): BotAction {
  if (typeof input === 'string') {
    const trimmed = input.trim().toLowerCase();
    switch (trimmed) {
      case 'thrust':
        return { type: 'thrust', angle: 0 };
      case 'rotate-left':
      case 'turn-left':
        return { type: 'rotate', direction: -1 };
      case 'rotate-right':
      case 'turn-right':
        return { type: 'rotate', direction: 1 };
      case 'fire':
      case 'shoot':
        return { type: 'fire' };
      case 'wait':
      case 'pass':
        return { type: 'wait' };
      default:
        return { type: 'wait' };
    }
  }

  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';

    switch (type) {
      case 'thrust':
        return {
          type: 'thrust',
          angle: typeof obj.angle === 'number' ? obj.angle : 0,
        };
      case 'rotate':
        return {
          type: 'rotate',
          direction: (obj.direction === -1 || obj.direction === 'left' || obj.direction === -1) ? -1 : 1,
        };
      case 'fire':
      case 'shoot':
        return { type: 'fire' };
      case 'wait':
      case 'pass':
        return { type: 'wait' };
      default:
        return { type: 'wait' };
    }
  }

  return { type: 'wait' };
}

/**
 * Convert a BotAction back into a human-readable string.
 * Useful for logging and debugging agent behavior.
 *
 * @param action - A BotAction to describe
 * @returns A readable description (e.g. "thrust at angle 1.57 rad", "rotate right", "fire", "wait")
 */
export function describeAction(action: BotAction): string {
  switch (action.type) {
    case 'thrust':
      return `thrust at angle ${action.angle.toFixed(2)} rad`;
    case 'rotate':
      return `rotate ${action.direction > 0 ? 'right' : 'left'}`;
    case 'fire':
      return 'fire';
    case 'wait':
      return 'wait';
  }
}

/**
 * Apply a BotAction to a ship state, mutating it in place.
 *
 * Updates the ship's thrust, rotation, and firing state based on the action.
 * The `wait` action damps angular velocity and clears thrust/fire flags.
 *
 * @param ship   - Mutable ship state object (shape matches ShipState)
 * @param action - The bot action to apply
 * @param config - Game configuration (provides shipThrust, shipRotationSpeed)
 */
export function applyActionToShip(
  ship: any,           // mutable ship state
  action: BotAction,
  config: any,         // game config
): void {
  switch (action.type) {
    case 'rotate':
      ship.angularVel = action.direction * config.shipRotationSpeed;
      break;
    case 'thrust':
      ship.thrust = true;
      ship.thrustAngle = action.angle;
      break;
    case 'fire':
      ship.canFire = true;
      break;
    case 'wait':
      ship.thrust = false;
      ship.angularVel *= 0.9; // natural damping
      ship.canFire = false;
      break;
  }
}
