import { describe, expect, it } from "vitest";
import { parsePairLink } from "./pairLink";

// As the daemon builds it (crates/moonletd/src/mobile.rs, pair_url).
const LINK =
  "moonlet://pair?v=1&host=Alex%27s%20MacBook%20Pro&addr=100.101.102.103%3A47428&addr=%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A47428&code=00112233445566778899aabbccddeeff";

describe("parsePairLink", () => {
  it("reads the Mac's name, every address and the code", () => {
    expect(parsePairLink(LINK)).toEqual({
      host: "Alex's MacBook Pro",
      addrs: ["100.101.102.103:47428", "[fd7a:115c:a1e0::1]:47428"],
      code: "00112233445566778899aabbccddeeff",
    });
  });

  it("accepts the link with spaces around it, as pasted", () => {
    expect(parsePairLink(`  ${LINK}\n`)?.code).toBe("00112233445566778899aabbccddeeff");
  });

  it("reads the short code of a daemon with X57", () => {
    expect(parsePairLink("moonlet://pair?v=1&host=studio-mini&addr=100.101.102.103%3A47428&code=7KQ2MX9PDA")?.code).toBe(
      "7KQ2MX9PDA",
    );
  });

  it("refuses other links and other versions", () => {
    expect(parsePairLink("https://example.com/pair?code=00")).toBeNull();
    expect(parsePairLink(LINK.replace("v=1", "v=2"))).toBeNull();
    expect(parsePairLink("not a link")).toBeNull();
  });

  it("refuses a link without a code or an address", () => {
    expect(parsePairLink("moonlet://pair?v=1&host=x&addr=100.64.0.1%3A47428")).toBeNull();
    expect(parsePairLink("moonlet://pair?v=1&host=x&code=00112233445566778899aabbccddeeff")).toBeNull();
    expect(parsePairLink("moonlet://pair?v=1&host=x&addr=100.64.0.1%3A47428&code=zz")).toBeNull();
    // U is not in the short code's alphabet.
    expect(parsePairLink("moonlet://pair?v=1&host=x&addr=100.64.0.1%3A47428&code=7KQ2MX9PDU")).toBeNull();
  });

  it("names the Mac 'Mac' when the link has no name", () => {
    expect(parsePairLink("moonlet://pair?v=1&addr=100.64.0.1%3A47428&code=00112233445566778899aabbccddeeff")?.host).toBe("Mac");
  });
});
