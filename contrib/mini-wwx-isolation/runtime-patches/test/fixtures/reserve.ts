import { reserveGuestPort } from '../../src/utils/guestPort'

const ports = [reserveGuestPort('t1'), reserveGuestPort('t2'), reserveGuestPort('t3')]
console.log(JSON.stringify(ports))
// Hold the reservations long enough for the sibling processes to finish
// allocating, so an overlapping allocation would be visible as a duplicate.
await Bun.sleep(400)
