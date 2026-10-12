import { PhoneSentinel } from "./index";

const sentinel = new PhoneSentinel();
const active = sentinel.getActiveDevice();

console.log("=== Phone Sentinel Status ===");
if (active) {
  console.log(`Status: CONNECTED (${active.serial})`);
} else {
  console.log("Status: DISCONNECTED / RECONNECTING");
}
