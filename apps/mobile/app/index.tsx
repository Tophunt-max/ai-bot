import { Redirect } from "expo-router";
import { Loading, Screen } from "../src/components/ui";
import { useAuth } from "../src/stores/auth";

export default function Index() {
  const { token, hydrated } = useAuth();
  if (!hydrated)
    return (
      <Screen banner={false}>
        <Loading />
      </Screen>
    );
  return <Redirect href={token ? "/(tabs)/dashboard" : "/(auth)/login"} />;
}
