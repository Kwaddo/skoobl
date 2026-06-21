import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Backdrop } from "@/components/Backdrop";

export const Route = createRootRoute({
  component: () => (
    <>
      <Backdrop />
      <Outlet />
    </>
  ),
});
