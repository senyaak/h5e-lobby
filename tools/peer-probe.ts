/**
 * Standing in for the other player — first to see whether he is dialled at all, then
 * to carry what he is sent.
 *
 * Three launches on 14.08.2026 settled where the peer address comes from:
 *
 * 1. A duel captured on the loopback adapter: the peers speak UDP straight to each
 *    other at the machine's LAN address and at each other's `net_game_port`
 *    (8888 <-> 8889), one socket each, 16 kB of payload in 186 seconds. The address the
 *    NAT service mirrored back to them was never dialled.
 * 2. Every player announced to the others at an address of ours in the member record —
 *    and nothing changed: they found each other and played a full duel anyway. So no
 *    field the server fills in carries it.
 * 3. The same four bytes rewritten inside the host's description of the game
 *    (`probeEndpoints`) — and both clients dialled us, in both directions, with no
 *    packet to the real address at all. That document is the carrier, and it is one we
 *    already pass through our hands.
 *
 * Run 3 also said WHEN: the dialling began within a second of the guest's `JOIN_ROOM`,
 * before START_GAME was ever sent. Peers meet in the room, not at the start of the game.
 *
 * So this now does the other half. A socket bound at `pool[i]:PORTS[i]` **is** the
 * player who plays on that port, as far as everyone else is concerned: it receives what
 * is sent to him and it is what his own packets appear to come from. A datagram landing
 * on the socket of P from the port of Q is Q talking to P, and goes out of Q's socket to
 * P for real — which is a relay, in the shape the internet one will have, with the loop
 * back address standing in for the far side of a tunnel.
 *
 *   node tools/peer-probe.ts              stand in AND carry — a duel should play
 *   node tools/peer-probe.ts --listen-only    answer nothing, only say who dialled
 */
import { createSocket, type Socket } from 'node:dgram';
import { probePeerAddress } from '../services/gateway/lobby.ts';

/** The game ports the copies of the game on this machine play on. */
const PORTS = [8888, 8889, 8890];
const LISTEN_ONLY = process.argv.includes('--listen-only');
/** Where a player really is, once his packets are to be delivered rather than watched. */
const REAL = '127.0.0.1';

const stamp = (): string => new Date().toISOString().slice(11, 23);
const head = (bytes: Buffer, take = 24): string =>
  bytes.subarray(0, take).toString('hex').replace(/(..)/g, '$1 ').trim() + (bytes.length > take ? ' …' : '');

/** One entry per port: the socket that stands in for that player, and what it carried. */
const standIn = new Map<number, { socket: Socket; address: string; packets: number; bytes: number }>();

for (const [i, port] of PORTS.entries()) {
  const address = probePeerAddress.pool[i];
  if (!address) continue;
  const socket = createSocket('udp4');
  const seat = { socket, address, packets: 0, bytes: 0 };

  socket.on('message', (payload, from) => {
    const sender = standIn.get(from.port);
    seat.packets += 1;
    seat.bytes += payload.length;

    // The first few of each pairing are printed whole; after that the summary below is
    // the record, because a duel is thousands of packets and a log nobody reads is worse
    // than a number that is right.
    if (seat.packets <= 3) {
      console.log(`${stamp()}  ${address}:${port} <- ${from.address}:${from.port}  ${payload.length} bytes  ${head(payload)}`);
    }

    if (LISTEN_ONLY) return;
    if (!sender) {
      console.log(`${stamp()}  ${address}:${port} <- ${from.address}:${from.port} — no seat for that port, dropped`);
      return;
    }
    // Out of the SENDER's socket, so that what arrives looks like it came from the
    // address the other player was told about. Sending it from here instead would be a
    // packet from a stranger, and the peer has no reason to take it.
    sender.socket.send(payload, port, REAL);
  });

  socket.on('error', (error: NodeJS.ErrnoException) => {
    console.log(`${stamp()}  ${address}:${port} not listening — ${error.code ?? error.message}`);
    socket.close();
    standIn.delete(port);
  });

  socket.bind(port, address);
  standIn.set(port, seat);
}

console.log(
  `${stamp()}  ${LISTEN_ONLY ? 'watching' : 'carrying'} for ` +
    [...standIn].map(([port, seat]) => `${seat.address}:${String(port)}`).join(', ') +
    ' — start the server with --probe-peer-address',
);

// A line only when something moved, so a quiet run stays quiet and a busy one says how
// busy without being read packet by packet.
let said = '';
setInterval(() => {
  const now = [...standIn]
    .filter(([, seat]) => seat.packets)
    .map(([port, seat]) => `${seat.address}:${String(port)} ${String(seat.packets)}p ${String(seat.bytes)}b`)
    .join('  |  ');
  if (now && now !== said) {
    console.log(`${stamp()}  ${now}`);
    said = now;
  }
}, 5000).unref?.();
