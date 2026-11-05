import { useEffect, useState } from "react";
import {
  AUTH_CONFIGURATION_ERROR,
  loadPublicAuthConfiguration,
  type PublicAuthConfiguration,
} from "./public-configuration";

type State =
  | { status: "loading"; configuration: null; error: "" }
  | { status: "ready"; configuration: PublicAuthConfiguration; error: "" }
  | { status: "unavailable"; configuration: null; error: string };
const loading: State = { status: "loading", configuration: null, error: "" };

export function useAuthConfiguration() {
  const [state, setState] = useState<State>(loading);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadPublicAuthConfiguration({ signal: controller.signal }).then(
      (configuration) => {
        if (!controller.signal.aborted) setState({ status: "ready", configuration, error: "" });
      },
      () => {
        if (!controller.signal.aborted)
          setState({ status: "unavailable", configuration: null, error: AUTH_CONFIGURATION_ERROR });
      },
    );
    return () => controller.abort();
  }, [attempt]);
  const retry = () => {
    setState(loading);
    setAttempt((value) => value + 1);
  };
  return { ...state, retry };
}
