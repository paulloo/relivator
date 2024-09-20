import { cache } from "react";

import { unstable_cache } from "next/cache";

import { initTRPC, TRPCError } from "@trpc/server";
import { experimental_nextAppDirCaller } from "@trpc/server/adapters/next-app-dir";
import { z } from "zod";

import { authjs } from "~/auth/authjs";
import { db } from "~/db";

type Meta = {
  span: string;
};

// Initializing tRPC with meta configuration
const t = initTRPC.meta<Meta>().create();

// Creating context for procedures
const createContext = cache(async () => {
  const session = await authjs();

  // const log = createLogger('trpc').child({
  //   user: session?.user,
  // })
  const log = console;

  return {
    log,
    user: session,
  };
});

// Base procedure configuration with tracing & logging
// @see https://github.com/juliusmarminge/trellix-trpc
// @see https://github.com/baselime/node-opentelemetry/blob/main/TRPC.md
const nextProc = t.procedure // .use(tracing({ collectInput: true, collectRes: true }))
  .use(async (options) => {
    const context = await createContext();

    // const input = await opts.getRawInput()
    // const log = ctx.log.child({ input })
    const { log } = context;

    if (t._config.isDev) {
      // artificial delay in dev
      const waitMs = Math.floor(Math.random() * 400) + 100;

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const start = Date.now();

    const res = await options.next({
      ctx: {
        ...context,
        log,
      },
    });

    const duration = Date.now() - start;

    if (res.ok) {
      log.info({
        duration,
        res: res.data,
      });
    } else {
      log.error({
        duration,
        error: res.error,
      });
    }

    return res;
  })
  .experimental_caller(
    experimental_nextAppDirCaller({
      pathExtractor: ({ meta }) => meta as Meta["span"],
    }),
  );

// Public procedure
export const publicAction = nextProc;

// Protected procedure with user authentication
export const protectedAction = nextProc.use(
  async (options) => {
    const user = await authjs();

    if (!user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
      });
    }

    return options.next({
      ctx: {
        ...options.ctx,
        user,
      },
    });
  },

  // ensures type is non-nullable
);

// Procedure with board access validation
export const protectedBoardAction = protectedAction
  .input(
    z.object({
      boardId: z.string(),
    }),
  )
  .use(async (options) => {
    const board = await db.query.boards.findFirst({
      where: (fields, ops) =>
        ops.and(
          ops.eq(fields.ownerId, options.ctx.user.id),
          ops.eq(fields.id, options.input.boardId),
        ),
    });

    if (!board) {
      throw new TRPCError({
        code: "FORBIDDEN",
      });
    }

    return options.next({
      ctx: {
        board,
      },
    });
  });

// Caching layer for protected actions
export const cachedDataLayer = (cacheTag: string) =>
  protectedAction.use(async (options) =>
    unstable_cache(
      async () => {
        const res = await options.next();

        if (!res.ok) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
          });
        }

        return res;
      }, // should maybe make sure this is serializable
      [options.ctx.user.id],
      {
        tags: [cacheTag],
      },
    )(),
  );
