import { Tracker } from "meteor/tracker";
import { Meteor } from "meteor/meteor";
import {
  computed,
  getCurrentInstance,
  markRaw,
  onUnmounted,
  reactive,
  ref,
  watch,
  watchEffect,
  ComputedRef,
} from "vue";

export const config = {
  subscribe: Meteor.subscribe,
};

interface Stoppable {
  stop: () => void;
}

export interface AutorunEffect<TResult> extends Stoppable {
  result: ComputedRef<TResult>;
}

/**
 * Wrap a Tracker autorun in a Vue watchEffect.
 * The returned computed value is updated reactively.
 */
export function autorun<TResult = unknown>(
  callback: () => TResult
): AutorunEffect<TResult> {
  const result = ref<TResult>();
  const stop = watchEffect((onInvalidate) => {
    const computation = Tracker.autorun(() => {
      let value: any = callback();
      // If the returned value is a cursor, fetch its data.
      if (typeof value?.fetch === "function") {
        value = value.fetch();
      }
      // Mark objects as raw so Vue doesn’t convert them.
      result.value =
        value && typeof value === "object" ? markRaw(value) : value;
    });
    onInvalidate(() => {
      computation.stop();
    });
  });
  return {
    result: computed(() => result.value as TResult),
    stop,
  };
}

export interface ReactiveMeteorSubscription extends Stoppable {
  ready: ComputedRef<boolean>;
  sub: Meteor.SubscriptionHandle;
}

/**
 * Subscribe either with static parameters or a reactive function.
 */
export function subscribe(
  payload: string | (() => [string, ...any[]] | false),
  ...args: any[]
): ReactiveMeteorSubscription {
  if (typeof payload === "string") {
    return simpleSubscribe(payload, ...args);
  } else {
    return watchSubscribe(payload);
  }
}

function simpleSubscribe(
  name: string,
  ...args: any[]
): ReactiveMeteorSubscription {
  const sub = config.subscribe(name, ...args);
  const ready = autorun(() => sub.ready());
  function stop() {
    ready.stop();
    sub.stop();
  }
  if (getCurrentInstance()) {
    onUnmounted(() => {
      stop();
    });
  }
  return {
    stop,
    ready: ready.result,
    sub,
  };
}

function watchSubscribe(
  callback: () => [string, ...any[]] | false
): ReactiveMeteorSubscription {
  const ready = ref(false);
  const sub = ref<Meteor.SubscriptionHandle>();
  const stop = watch(
    callback,
    (value, oldValue, onInvalidate) => {
      if (value !== false) {
        sub.value = markRaw(config.subscribe(...value));
        const computation = Tracker.autorun(() => {
          ready.value = sub.value.ready();
        });
        onInvalidate(() => {
          sub.value.stop();
          computation.stop();
        });
      }
    },
    { immediate: true, deep: true }
  );
  return {
    stop,
    ready: computed(() => ready.value),
    get sub() {
      return sub.value;
    },
  };
}

/**
 * Create composable helpers that automatically stop all registered effects when the component unmounts.
 */
function makeComposable<
  TName extends string = string,
  TReturn extends Stoppable = Stoppable,
  TFn extends (...args: any[]) => TReturn = (...args: any[]) => TReturn
>(
  name: TName,
  fn: TFn
): () => {
  [K in TName]: TFn;
} {
  return () => {
    const effects: Stoppable[] = [];
    const _run = (...args) => {
      const effect = fn(...args);
      effects.push(effect);
      return effect;
    };
    onUnmounted(() => {
      effects.forEach((effect) => effect.stop());
    });
    return {
      [name]: _run,
    } as {
      [K in TName]: TFn;
    };
  };
}

export const useAutorun = makeComposable("autorun", autorun);
export const useSubscribe = makeComposable("subscribe", subscribe);

/**
 * Warn if these functions are used outside of setup().
 */
function makeSetupOnlyFunction<TFn extends (...args: any[]) => any>(
  fn: TFn
): TFn {
  return ((...args) => {
    if (process.env.NODE_ENV !== "production") {
      if (!getCurrentInstance()) {
        console.warn(
          `'${fn.name}()' should only be used in setup() inside components.`
        );
      }
    }
    return fn(...args);
  }) as TFn;
}

const setupOnlyAutorun = makeSetupOnlyFunction(autorun);
const setupOnlySubscribe = makeSetupOnlyFunction(subscribe);

// export { setupOnlyAutorun as autorun, setupOnlySubscribe as subscribe }

export function callMethod<TResult = any>(
  methodName: string,
  ...args: any[]
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    Meteor.call(methodName, ...args, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}

export type MethodResultCallback<TResult = any> = (
  error: Error | undefined,
  result: TResult | undefined
) => unknown;

/**
 * Wrap Meteor method calls in a composable that tracks pending state, errors, and results.
 */
export function useMethod<TArgs extends any[] = any[], TResult = any>(
  name: string
) {
  const pending = ref(false);
  const error = ref<Error>();
  const result = ref<TResult>();
  const callbacks: MethodResultCallback<TResult>[] = [];
  async function call(...args: TArgs) {
    pending.value = true;
    error.value = undefined;
    try {
      result.value = await callMethod(name, ...args);
      return result.value;
    } catch (e) {
      error.value = e as Error;
    } finally {
      pending.value = false;
      callbacks.forEach((callback) => callback(error.value, result.value));
    }
  }
  function onResult(callback: MethodResultCallback<TResult>) {
    callbacks.push(callback);
  }
  return {
    call,
    pending,
    error,
    result,
    onResult,
  };
}

/**
 * VueMeteor plugin.
 * When installed via app.use(VueMeteor) in Vue 3,
 * it automatically processes the `meteor` option in component definitions.
 */
export const VueMeteor = {
  install(app) {
    app.mixin({
      beforeCreate() {
        if (this.$options.meteor) {
          const subReady = reactive({});
          if (this.$options.meteor.$subscribe) {
            for (const key in this.$options.meteor.$subscribe) {
              const value = this.$options.meteor.$subscribe[key];
              const { ready } =
                typeof value === "function"
                  ? subscribe(() => {
                      const result = value.call(this);
                      return [key, ...result];
                    })
                  : subscribe(key, ...value);
              subReady[key] = ready;
            }
          }
          this.$options.computed = this.$options.computed || {};
          this.$options.computed.$subReady = () => subReady;
          const { subscribe: $subscribe } = useSubscribe();
          this.$options.methods = this.$options.methods || {};
          this.$options.methods.$subscribe = $subscribe;

          let boundContext = {};
          for (const key in this.$options.meteor) {
            // boundContext[key] = this.$options.meteor[key].bind(boundContext)
            Object.defineProperty(boundContext, key, {
              get: () => this.$options.meteor[key].bind(boundContext)(),
            });
          }
          boundContext = Object.assign(this, boundContext);

          for (const key in this.$options.meteor) {
            if (key.startsWith("$")) continue;
            const fn = this.$options.meteor[key];
            const { result } = autorun(fn.bind(boundContext));
            this.$options.computed[key] = () => result.value;
          }
        }
      },
    });
  },
};
