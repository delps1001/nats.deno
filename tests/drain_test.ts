/*
 * Copyright 2020 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
import {
  assert,
  assertEquals,
  assertThrows,
  assertThrowsAsync,
  fail,
} from "https://deno.land/std/testing/asserts.ts";
import { connect, ErrorCode, Nuid, Msg } from "../src/mod.ts";

import { assertErrorCode, Lock } from "./helpers/mod.ts";

const u = "https://demo.nats.io:4222";
const nuid = new Nuid();

Deno.test("connection drains when no subs", async () => {
  let nc = await connect({ url: u });
  await nc.drain();
  await nc.close();
});

Deno.test("connection drain", async () => {
  const lock = Lock();

  const subj = nuid.next();

  const nc1 = await connect({ url: u });
  let c1 = 0;
  await nc1.subscribe(subj, () => {
    c1++;
    if (c1 === 1) {
      let dp = nc1.drain();
      dp.then(() => {
        lock.unlock();
      }).catch((ex) => {
        fail(ex);
      });
    }
  }, { queue: "q1" });

  const nc2 = await connect({ url: u });
  let c2 = 0;
  await nc2.subscribe(subj, () => {
    c2++;
  }, { queue: "q1" });

  await nc1.flush();
  await nc2.flush();

  for (let i = 0; i < 10000; i++) {
    nc2.publish(subj);
    // FIXME: shouldn't be necessary to flush
    if (i % 1000 === 0) {
      await nc2.flush();
    }
  }
  await nc2.flush();
  // @ts-ignore

  await lock;

  assertEquals(c1 + c2, 10000);
  assert(c1 >= 1, "s1 got more than one message");
  assert(c2 >= 1, "s2 got more than one message");
  await nc2.close();
});

Deno.test("subscription drain", async () => {
  let lock = Lock();
  let nc = await connect({ url: u });
  let subj = nuid.next();
  let c1 = 0;
  let s1 = nc.subscribe(subj, () => {
    c1++;
    if (!s1.isDraining()) {
      // resolve when done
      s1.drain()
        .then(() => {
          lock.unlock();
        });
    }
  }, { queue: "q1" });

  let c2 = 0;
  nc.subscribe(subj, () => {
    c2++;
  }, { queue: "q1" });

  for (let i = 0; i < 10000; i++) {
    nc.publish(subj);
    // FIXME: this shouldn't be necessary
    if (i % 1000 === 0) {
      await nc.flush();
    }
  }
  await nc.flush();
  await lock;

  assertEquals(c1 + c2, 10000);
  assert(c1 >= 1, "s1 got more than one message");
  assert(c2 >= 1, "s2 got more than one message");
  assert(s1.isCancelled());
  await nc.close();
});

Deno.test("publisher drain", async () => {
  const lock = Lock();
  const subj = nuid.next();

  const nc1 = await connect({ url: u });
  let c1 = 0;
  await nc1.subscribe(subj, () => {
    c1++;
    if (c1 === 1) {
      let dp = nc1.drain();
      for (let i = 0; i < 100; i++) {
        nc1.publish(subj);
      }
      dp.then(() => {
        lock.unlock();
      })
        .catch((ex) => {
          fail(ex);
        });
    }
  }, { queue: "q1" });

  const nc2 = await connect({ url: u });
  let c2 = 0;
  await nc2.subscribe(subj, () => {
    c2++;
  }, { queue: "q1" });

  await nc1.flush();

  for (let i = 0; i < 10000; i++) {
    nc2.publish(subj);
    // FIXME: this shouldn't be necessary
    if (i % 1000 === 0) {
      await nc2.flush();
    }
  }
  await nc2.flush();

  await lock;

  assertEquals(c1 + c2, 10000 + 100);
  assert(c1 >= 1, "s1 got more than one message");
  assert(c2 >= 1, "s2 got more than one message");
  await nc2.close();
});

Deno.test("publish after drain fails", async () => {
  const subj = nuid.next();
  const nc = await connect({ url: u });
  nc.subscribe(subj, () => {});
  await nc.drain();

  const err = assertThrows(() => {
    nc.publish(subj);
  });
  assertErrorCode(
    err,
    ErrorCode.CONNECTION_CLOSED,
    ErrorCode.CONNECTION_DRAINING,
  );
});

Deno.test("reject reqrep during connection drain", async () => {
  let lock = Lock();
  let subj = nuid.next();
  // start a service for replies
  let nc1 = await connect({ url: u });
  await nc1.subscribe(subj, (_, msg: Msg) => {
    if (msg.reply) {
      msg.respond("ok");
    }
  });
  nc1.flush();

  let nc2 = await connect({ url: u });
  let first = true;
  let done = Lock();
  await nc2.subscribe(subj, async () => {
    if (first) {
      first = false;
      nc2.drain()
        .then(() => {
          done.unlock();
        });
      try {
        // should fail
        await nc2.request(subj + "a", 1000);
        fail("shouldn't have been able to request");
        lock.unlock();
      } catch (err) {
        assertEquals(err.code, ErrorCode.CONNECTION_DRAINING);
        lock.unlock();
      }
    }
  });
  // publish a trigger for the drain and requests
  nc2.publish(subj, "here");
  await nc2.flush();
  await lock;
  await nc1.close();
  await done;
});

Deno.test("reject drain on closed", async () => {
  const nc = await connect({ url: u });
  await nc.close();
  const err = await assertThrowsAsync(() => {
    return nc.drain();
  });
  assertErrorCode(err, ErrorCode.CONNECTION_CLOSED);
});

Deno.test("reject drain on draining", async () => {
  const nc = await connect({ url: u });
  const done = nc.drain();
  const err = await assertThrowsAsync(() => {
    return nc.drain();
  });
  await done;
  assertErrorCode(err, ErrorCode.CONNECTION_DRAINING);
});

Deno.test("reject subscribe on draining", async () => {
  const nc = await connect({ url: u });
  const done = nc.drain();
  const err = await assertThrowsAsync(async (): Promise<any> => {
    return nc.subscribe("foo", () => {});
  });
  assertErrorCode(err, ErrorCode.CONNECTION_DRAINING);
  await done;
});

Deno.test("reject subscription drain on closed sub", async () => {
  let nc = await connect({ url: u });
  let sub = nc.subscribe("foo", () => {});
  await sub.drain();
  const err = await assertThrowsAsync((): Promise<any> => {
    return sub.drain();
  });
  await nc.close();
  assertErrorCode(err, ErrorCode.SUB_CLOSED);
});

Deno.test("connection is closed after drain", async () => {
  let nc = await connect({ url: u });
  nc.subscribe("foo", () => {});
  await nc.drain();
  assert(nc.isClosed());
});

Deno.test("reject subscription drain on closed", async () => {
  let nc = await connect({ url: u });
  let sub = nc.subscribe("foo", () => {});
  await nc.close();
  const err = await assertThrowsAsync(() => {
    return sub.drain();
  });
  assertErrorCode(err, ErrorCode.CONNECTION_CLOSED);
});

Deno.test("reject subscription drain on draining sub", async () => {
  let nc = await connect({ url: u });
  let subj = nuid.next();
  let sub = nc.subscribe(subj, async () => {
    sub.drain();
    const err = await assertThrowsAsync(() => {
      return sub.drain();
    });
    assertErrorCode(err, ErrorCode.SUB_DRAINING);
    await nc.close();
  });
  nc.publish(subj);
  await nc.flush();
});