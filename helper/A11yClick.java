// Clicks the UI element at a screen point through the accessibility API, the way a screen reader
// (TalkBack) does, instead of injecting a touch. Some screens (e.g. WhatsApp registration) ignore
// injected touches but must accept accessibility clicks.
//
// Runs on the device via app_process with /system/framework/uiautomator.jar on the classpath:
//   CLASSPATH=/data/local/tmp/a11y.jar:/system/framework/uiautomator.jar \
//     app_process /system/bin A11yClick <x> <y>
// Prints one line of JSON. Android classes are reached by reflection, so this compiles with a plain
// JDK (no Android SDK) and is converted with d8 (see scripts/build-helper.sh).
import java.lang.reflect.Method;

public class A11yClick {
    static final int ACTION_FOCUS = 1;
    static final int ACTION_CLICK = 16;
    // Don't click huge containers (e.g. a tap on empty background): max share of the screen area.
    static final double MAX_AREA_FRACTION = 0.5;

    static Object best;
    static long bestArea;
    static long screenArea;
    static int px, py;

    public static void main(String[] args) throws Exception {
        px = Integer.parseInt(args[0]);
        py = Integer.parseInt(args[1]);

        Class<?> wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
        Object wrapper = wrapperClass.getConstructor().newInstance();
        wrapperClass.getMethod("connect").invoke(wrapper);
        try {
            wrapperClass.getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
            Object ua = wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
            ua.getClass().getMethod("waitForIdle", long.class, long.class).invoke(ua, 100L, 500L);
            Object root = null;
            for (int i = 0; i < 5 && root == null; i++) {
                root = ua.getClass().getMethod("getRootInActiveWindow").invoke(ua);
                if (root == null) Thread.sleep(200);
            }
            if (root == null) {
                System.out.println("{\"ok\":false,\"error\":\"no active window\"}");
                return;
            }
            int[] rb = bounds(root);
            screenArea = (long) (rb[2] - rb[0]) * (rb[3] - rb[1]);
            walk(root);
            if (best == null) {
                System.out.println("{\"ok\":false,\"error\":\"nothing clickable here\"}");
                return;
            }
            Class<?> n = best.getClass();
            boolean editable = (Boolean) n.getMethod("isEditable").invoke(best);
            if (editable) n.getMethod("performAction", int.class).invoke(best, ACTION_FOCUS);
            boolean ok = (Boolean) n.getMethod("performAction", int.class).invoke(best, ACTION_CLICK);
            Object id = n.getMethod("getViewIdResourceName").invoke(best);
            int[] b = bounds(best);
            System.out.println("{\"ok\":" + ok + ",\"id\":\"" + (id == null ? "" : id) + "\",\"class\":\""
                + n.getMethod("getClassName").invoke(best) + "\",\"bounds\":[" + b[0] + "," + b[1] + ","
                + b[2] + "," + b[3] + "]}");
        } finally {
            wrapperClass.getMethod("disconnect").invoke(wrapper);
        }
    }

    // Picks the smallest visible clickable (or editable) node containing the point: what a finger
    // there would have hit.
    static void walk(Object node) throws Exception {
        if (node == null) return;
        Class<?> n = node.getClass();
        if (!(Boolean) n.getMethod("isVisibleToUser").invoke(node)) return;
        int[] b = bounds(node);
        if (px < b[0] || px >= b[2] || py < b[1] || py >= b[3]) return;
        boolean clickable = (Boolean) n.getMethod("isClickable").invoke(node);
        boolean editable = (Boolean) n.getMethod("isEditable").invoke(node);
        long area = (long) (b[2] - b[0]) * (b[3] - b[1]);
        if ((clickable || editable) && area <= screenArea * MAX_AREA_FRACTION
                && (best == null || area <= bestArea)) {
            best = node;
            bestArea = area;
        }
        Method getChild = n.getMethod("getChild", int.class);
        int count = (Integer) n.getMethod("getChildCount").invoke(node);
        for (int i = 0; i < count; i++) walk(getChild.invoke(node, i));
    }

    static int[] bounds(Object node) throws Exception {
        Class<?> rectClass = Class.forName("android.graphics.Rect");
        Object r = rectClass.getConstructor().newInstance();
        node.getClass().getMethod("getBoundsInScreen", rectClass).invoke(node, r);
        return new int[] {
            rectClass.getField("left").getInt(r), rectClass.getField("top").getInt(r),
            rectClass.getField("right").getInt(r), rectClass.getField("bottom").getInt(r)
        };
    }
}
