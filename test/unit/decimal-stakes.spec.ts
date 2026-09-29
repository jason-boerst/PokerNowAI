import { expect } from "chai";

import { LogService } from "../../app/services/log-service.ts";
import { getIdToInitialStackFromMsg, validateAllMsg } from "../../app/utils/message-processing-utils.ts";
import { convertToValue } from "../../app/utils/value-conversion-utils.ts";

describe("decimal stakes", () => {
    it("reads starting stacks with decimals and thousands separators", () => {
        const msg = 'Player stacks: #1 "bot @ abc123" (19.90) | #3 "alice @ def456" (1,020.50)';
        const stacks = getIdToInitialStackFromMsg(msg, 0.2);
        expect(stacks.get("abc123")).to.be.closeTo(99.5, 1e-9);
        expect(stacks.get("def456")).to.be.closeTo(5102.5, 1e-9);
    });

    it("keeps the decimal point in bet sizes", () => {
        const res = validateAllMsg([
            '"alice @ def456" calls 0.20',
            '"bot @ abc123" raises to 0.60',
            '"alice @ def456" posts a small blind of 0.10',
            '"bot @ abc123" bets 1,200'
        ]);
        expect(res.map((r) => r[4])).to.deep.equal(["0.20", "0.60", "0.10", "1200"]);
    });

    it("converts BBs back to chips without truncating small stakes", () => {
        expect(convertToValue(3, 0.2)).to.equal(0.6);
        expect(convertToValue(2.5, 20)).to.equal(50);
    });
});

describe("LogService", () => {
    const logs = (msgs: string[]) => ({ data: { logs: msgs.map((msg, i) => ({ msg, at: `${i}`, created_at: `${i}` })) } });

    it("keeps entries up to the start of the current hand", () => {
        const svc = new LogService("g");
        const data = svc.getData(logs(['"a @ 1" calls 0.20', "-- starting hand #5 --", "-- ending hand #4 --"]));
        expect(svc.getMsg(svc.pruneLogsBeforeCurrentHand(data))).to.deep.equal(['"a @ 1" calls 0.20', "-- starting hand #5 --"]);
    });

    it("explains a missing hand start instead of crashing", () => {
        const svc = new LogService("g");
        const data = svc.getData(logs(['"a @ 1" calls 0.20']));
        expect(() => svc.pruneLogsBeforeCurrentHand(data)).to.throw(/starting hand #/);
    });

    it("ignores malformed entries", () => {
        const svc = new LogService("g");
        expect(svc.getMsg(svc.getData({ data: { logs: [null, { at: "1" }, { msg: "ok", at: "2", created_at: "2" }] } }))).to.deep.equal(["ok"]);
    });

    it("fetches through the page fetcher and reports bad responses", async () => {
        const ok = new LogService("g", async () => ({ status: 200, text: JSON.stringify({ logs: [{ msg: "x", at: "1", created_at: "1" }] }) }));
        expect((await ok.fetchData()).code).to.equal("success");

        const html = new LogService("g", async () => ({ status: 200, text: "<html>login</html>" }));
        const res = await html.fetchData();
        expect(res.code).to.equal("error");
        if (res.code === "error") expect(res.error.message).to.match(/did not return JSON/);

        const denied = new LogService("g", async () => ({ status: 403, text: "" }));
        const res2 = await denied.fetchData();
        if (res2.code === "error") expect(res2.error.message).to.match(/status 403/);
    });
});
