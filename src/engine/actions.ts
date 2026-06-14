/**
 * @module actions
 *
 * Bot action parsing, description, and application.
 *
 * `thrust` is ship-relative (forward / reverse along `ship.angle`).
 * Arbitrary-angle thrust is no longer supported — real-Asteroids parity
 * says turn-to-aim then thrust.
 */

import type { BotAction } from '../shared/types.js';

/**
 * Parse an input value (string or object) into a typed BotAction.
 *
 * Handles multiple string formats:
 *   'thrust', 'thrust-forward' → { type: 'thrust', direction: 1 }
 *   'reverse', 'thrust-reverse' → { type: 'thrust', direction: -1 }
 *   'rotate-left', 'turn-left' → { type: 'rotate', direction: -1 }
 *   'rotate-right', 'turn-right' → { type: 'rotate', direction: 1 }
 *   'fire', 'shoot' → { type: 'fire' }
 *   'wait', 'pass' → { type: 'wait' }
 *
 * Also handles object inputs with a `type` field (plus optional `direction`).
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
      case 'thrust-forward':
      case 'forward':
        return { type: 'thrust', direction: 1 };
      case 'reverse':
      case 'thrust-reverse':
      case 'brake':
        return { type: 'thrust', direction: -1 };
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
          direction: obj.direction === -1 || obj.direction === 'reverse' ? -1 : 1,
        };
      case 'rotate':
        return {
          type: 'rotate',
          direction: obj.direction === -1 || obj.direction === 'left' ? -1 : 1,
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
 * @returns A readable description (e.g. "thrust forward", "rotate right", "fire", "wait")
 */
export function describeAction(action: BotAction): string {
  switch (action.type) {
    case 'thrust':
      return `thrust ${action.direction > 0 ? 'forward' : 'reverse'}`;
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
 * Thrust direction is ship-relative: forward (direction:1) accelerates along
 * `ship.angle`; reverse (direction:-1) accelerates along `ship.angle + π`.
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
    case 'thrust': {
      ship.thrust = true;
      // Real-Asteroids: thrust is forward along ship.angle, or retrograde
      // (along ship.angle + π) when direction === -1.
      ship.thrustAngle =
        ship.angle + (action.direction === -1 ? Math.PI : 0);
      ship.thrustDirection = action.direction;
      break;
    }
    case 'fire':
      ship.canFire = true;
      break;
    case 'wait':
      ship.thrust = false;
      ship.angularVel *= 0.9; // natural damping (rotation only)
      ship.canFire = false;
      break;
  }
}
