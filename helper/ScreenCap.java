// Captures the screen including FLAG_SECURE windows (e.g. Chick-fil-A's QR code), which
// `screencap` refuses to capture (or blacks out, as root). It asks WindowManager to capture with
// captureSecureLayers; WindowManager runs as system, which SurfaceFlinger allows, and it accepts
// the request from root.
//
// Runs on the device as root, kept running by the server:
//   su 0 sh -c 'CLASSPATH=/data/local/tmp/helpers.jar app_process /system/bin ScreenCap'
// Each line on stdin requests one frame. The reply on stdout has screencap's raw format: a 16-byte
// little-endian header (width, height, format 1 = RGBA_8888, dataspace 0) then the RGBA pixels.
// A failed capture replies with width and height 0 and the error on stderr. Exits at end of stdin.
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class ScreenCap {
    static Object windowManager;
    static Method captureDisplay;
    static Object captureArgs;
    static Method createListener;
    static Object argb8888;
    static Method bitmapCopy;

    public static void main(String[] args) throws Exception {
        Class<?> screenCapture = Class.forName("android.window.ScreenCapture");
        Class<?> argsBuilder = Class.forName("android.window.ScreenCapture$CaptureArgs$Builder");
        Object b = argsBuilder.getConstructor().newInstance();
        argsBuilder.getMethod("setCaptureSecureLayers", boolean.class).invoke(b, true);
        captureArgs = argsBuilder.getMethod("build").invoke(b);
        createListener = screenCapture.getMethod("createSyncCaptureListener");

        Object binder = Class.forName("android.os.ServiceManager")
            .getMethod("getService", String.class).invoke(null, "window");
        windowManager = Class.forName("android.view.IWindowManager$Stub")
            .getMethod("asInterface", Class.forName("android.os.IBinder")).invoke(null, binder);
        for (Method m : windowManager.getClass().getMethods()) {
            if (m.getName().equals("captureDisplay")) captureDisplay = m;
        }
        if (captureDisplay == null) throw new RuntimeException("no IWindowManager.captureDisplay");

        Class<?> config = Class.forName("android.graphics.Bitmap$Config");
        argb8888 = config.getField("ARGB_8888").get(null);
        bitmapCopy = Class.forName("android.graphics.Bitmap").getMethod("copy", config, boolean.class);

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        OutputStream out = new BufferedOutputStream(new FileOutputStream(FileDescriptor.out), 1 << 20);
        while (in.readLine() != null) {
            byte[] frame;
            try {
                frame = capture();
            } catch (Throwable t) {
                Throwable cause = t.getCause() != null ? t.getCause() : t;
                System.err.println("capture failed: " + cause);
                frame = header(0, 0).array();
            }
            out.write(frame);
            out.flush();
        }
        System.exit(0);
    }

    static byte[] capture() throws Exception {
        Object listener = createListener.invoke(null);
        captureDisplay.invoke(windowManager, 0, captureArgs, listener);
        Object shot = method(listener.getClass(), "getBuffer").invoke(listener);
        if (shot == null) throw new RuntimeException("no buffer");
        Object hardwareBitmap = method(shot.getClass(), "asBitmap").invoke(shot);
        Object bitmap = bitmapCopy.invoke(hardwareBitmap, argb8888, false);
        try {
            Class<?> bc = bitmap.getClass();
            int width = (Integer) bc.getMethod("getWidth").invoke(bitmap);
            int height = (Integer) bc.getMethod("getHeight").invoke(bitmap);
            ByteBuffer frame = header(width, height);
            // ARGB_8888 is stored as R, G, B, A bytes: the same order as screencap's RGBA_8888.
            bc.getMethod("copyPixelsToBuffer", java.nio.Buffer.class).invoke(bitmap, frame);
            return frame.array();
        } finally {
            bitmap.getClass().getMethod("recycle").invoke(bitmap);
            hardwareBitmap.getClass().getMethod("recycle").invoke(hardwareBitmap);
            Object hardwareBuffer = method(shot.getClass(), "getHardwareBuffer").invoke(shot);
            hardwareBuffer.getClass().getMethod("close").invoke(hardwareBuffer);
        }
    }

    // A buffer sized for the whole frame, positioned after the header.
    static ByteBuffer header(int width, int height) {
        ByteBuffer b = ByteBuffer.allocate(16 + width * height * 4).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(width).putInt(height).putInt(1).putInt(0);
        return b;
    }

    // A no-argument method, including non-public ones on hidden classes.
    static Method method(Class<?> c, String name) {
        for (Class<?> k = c; k != null; k = k.getSuperclass()) {
            for (Method m : k.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterCount() == 0) {
                    m.setAccessible(true);
                    return m;
                }
            }
        }
        throw new RuntimeException("no method " + name + " on " + c);
    }
}
