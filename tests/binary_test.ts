/*
 * Copyright 2018-2020 The NATS Authors
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
 */

import {
  assertEquals,
} from "https://deno.land/std/testing/asserts.ts";
import {
  connect,
  Nuid,
  Payload,
  Msg,
  NatsError,
} from "../src/mod.ts";
import { Lock } from "./helpers/mod.ts";

const u = "https://demo.nats.io:4222";
const nuid = new Nuid();

function macro(input: any) {
  return async () => {
    const lock = Lock();
    const subj = nuid.next();
    const nc = await connect({ url: u, payload: Payload.BINARY });
    let err!: NatsError | null;
    let msg!: Msg;

    nc.subscribe(subj, (e, m: Msg) => {
      err = e;
      msg = m;
      lock.unlock();
    }, { max: 1 });

    nc.publish(subj, input);
    await nc.flush();
    await lock;
    await nc.close();

    // noinspection JSUnusedAssignment
    assertEquals(null, err);
    // noinspection JSUnusedAssignment
    assertEquals(msg.data, input);
  };
}

const invalid2octet = new Uint8Array([0xc3, 0x28]);
const invalidSequenceIdentifier = new Uint8Array([0xa0, 0xa1]);
const invalid3octet = new Uint8Array([0xe2, 0x28, 0xa1]);
const invalid4octet = new Uint8Array([0xf0, 0x90, 0x28, 0xbc]);
const embeddedNull = new Uint8Array(
  [0x00, 0xf0, 0x00, 0x28, 0x00, 0x00, 0xf0, 0x9f, 0x92, 0xa9, 0x00],
);

Deno.test("invalid2octet", macro(invalid2octet));
Deno.test("invalidSequenceIdentifier", macro(invalidSequenceIdentifier));
Deno.test("invalid3octet", macro(invalid3octet));
Deno.test("invalid4octet", macro(invalid4octet));
Deno.test("embeddednull", macro(embeddedNull));