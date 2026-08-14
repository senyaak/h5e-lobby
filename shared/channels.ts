// The channels, which are the one thing the game and the browser have to agree on.
//
// The game knows a channel as a lobby with a number; the browser knows it by name; the
// chat knows it as an IRC channel. Two of the four services need all three of those, so
// the list lives here rather than inside either of them — the core must not import the
// game's protocol, and the gateway must not be told what a channel is by the web.
//
// Exports:
//   Lobby, GameMode, DEFAULT_LOBBIES   what we offer
//   lobbyChannel(group, server)        its name in the chat
//   gameChannels()                     the same list as the core hands to the web

import type { ChannelInfo } from './core-protocol.ts';

/** Game modes, as the client counts them. */
export const GameMode = { STANDARD: 0, RATED: 1, DUEL: 2 } as const;

export interface Lobby {
  id: number;
  name: string;
  mode: number;
  maxMembers: number;
  members: number;
}

/** What we offer on the lobby screen. Ours to choose; the client only lists them. */
export const DEFAULT_LOBBIES: Lobby[] = [
  { id: 1, name: 'Casual', mode: GameMode.STANDARD, maxMembers: 8, members: 0 },
  { id: 2, name: 'Ranked', mode: GameMode.RATED, maxMembers: 8, members: 0 },
  { id: 3, name: '1v1', mode: GameMode.DUEL, maxMembers: 8, members: 0 },
];

/**
 * The channel of a lobby, as the client spells it: `#LobbyGrp<server>.<group>`.
 *
 * Server FIRST, group second — off the wire, where entering channel 2 on lobby server
 * 1 joins `#LobbyGrp1.2`. Read the other way round (which is how it was written the
 * first time) the guest talked into a channel that does not exist and nobody heard a
 * thing.
 */
export function lobbyChannel(group: number, server = 1): string {
  return `#LobbyGrp${server}.${group}`;
}

/** The list the core publishes: the chat name, the number, and what a person calls it. */
export function gameChannels(): ChannelInfo[] {
  return DEFAULT_LOBBIES.map((lobby) => ({ key: lobbyChannel(lobby.id), id: lobby.id, name: lobby.name }));
}
