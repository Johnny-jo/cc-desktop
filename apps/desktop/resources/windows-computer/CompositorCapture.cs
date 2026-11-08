using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Foundation;
using ApiInformation = Windows.Foundation.Metadata.ApiInformation;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

namespace AgentOS.Computer
{
    // All surfaces originate from CreateForWindow(hwnd). No monitor, screen DC or desktop duplication.
    internal static class CompositorCapture
    {
        private const int TimeoutMs = 3000;
        private static readonly Guid CaptureItemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
        private static readonly Guid DxgiDeviceId = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");

        [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IGraphicsCaptureItemInterop
        {
            IntPtr CreateForWindow(IntPtr hwnd, ref Guid iid);
        }

        [ComImport, Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMemoryBufferByteAccess
        {
            void GetBuffer(out IntPtr data, out uint capacity);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect { public int Left, Top, Right, Bottom; }

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out NativeRect rect, int length);
        [DllImport("d3d11.dll")]
        private static extern int D3D11CreateDevice(IntPtr adapter, uint driver, IntPtr software, uint flags,
            IntPtr levels, uint levelCount, uint sdkVersion, out IntPtr device, IntPtr chosenLevel, IntPtr context);
        [DllImport("d3d11.dll")]
        private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr device);

        private static GraphicsCaptureItem WindowItem(IntPtr hwnd)
        {
            var factory = (IGraphicsCaptureItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
            var iid = CaptureItemId;
            var raw = factory.CreateForWindow(hwnd, ref iid);
            try { return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(raw); }
            finally { Marshal.Release(raw); }
        }

        private static IDirect3DDevice CreateDevice()
        {
            IntPtr d3d = IntPtr.Zero, dxgi = IntPtr.Zero, winrt = IntPtr.Zero;
            try
            {
                // D3D11_SDK_VERSION = 7, D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20.
                int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out d3d, IntPtr.Zero, IntPtr.Zero);
                if (hr < 0) // WARP also supports systems without a hardware D3D device.
                    hr = D3D11CreateDevice(IntPtr.Zero, 5, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out d3d, IntPtr.Zero, IntPtr.Zero);
                Marshal.ThrowExceptionForHR(hr);
                var iid = DxgiDeviceId;
                Marshal.ThrowExceptionForHR(Marshal.QueryInterface(d3d, ref iid, out dxgi));
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out winrt));
                return (IDirect3DDevice)Marshal.GetObjectForIUnknown(winrt);
            }
            finally
            {
                if (winrt != IntPtr.Zero) Marshal.Release(winrt);
                if (dxgi != IntPtr.Zero) Marshal.Release(dxgi);
                if (d3d != IntPtr.Zero) Marshal.Release(d3d);
            }
        }

        private static Rectangle FrameBounds(IntPtr hwnd, Rectangle window, SizeInt32 content)
        {
            if (content.Width == window.Width && content.Height == window.Height) return window;
            // WGC normally omits invisible resize borders. Click coordinates and requested crops
            // remain relative to GetWindowRect, just as they are on the PrintWindow path.
            NativeRect rect;
            if (DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out rect, Marshal.SizeOf(typeof(NativeRect))) == 0)
            {
                var visible = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
                if (visible.Width == content.Width && visible.Height == content.Height && window.Contains(visible)) return visible;
            }
            throw new InvalidOperationException("The compositor image size does not match the window geometry. Capture the target again.");
        }

        private static byte[] ReadCrop(SoftwareBitmap bitmap, Rectangle frame, Rectangle crop)
        {
            if (bitmap.BitmapPixelFormat != BitmapPixelFormat.Bgra8 || bitmap.PixelWidth != frame.Width || bitmap.PixelHeight != frame.Height)
                throw new InvalidOperationException("Unexpected window compositor pixel format or size.");
            var result = new byte[checked(crop.Width * crop.Height * 3)];
            // Resize borders that Windows excludes from its image are explicitly padded black.
            var overlap = Rectangle.Intersect(frame, crop);
            if (overlap.Width <= 0 || overlap.Height <= 0) return result;
            using (var buffer = bitmap.LockBuffer(BitmapBufferAccessMode.Read))
            using (var reference = buffer.CreateReference())
            {
                var plane = buffer.GetPlaneDescription(0);
                IntPtr data;
                uint capacity;
                ((IMemoryBufferByteAccess)reference).GetBuffer(out data, out capacity);
                if (data == IntPtr.Zero || plane.StartIndex < 0 || plane.Width < frame.Width || plane.Height < frame.Height ||
                    plane.Stride < frame.Width * 4 || (long)plane.StartIndex + (long)(frame.Height - 1) * plane.Stride + frame.Width * 4 > capacity)
                    throw new InvalidOperationException("The compositor returned an incomplete window image.");
                var row = new int[overlap.Width];
                for (int y = overlap.Top; y < overlap.Bottom; y++)
                {
                    int offset = checked(plane.StartIndex + (y - frame.Y) * plane.Stride + (overlap.X - frame.X) * 4);
                    Marshal.Copy(IntPtr.Add(data, offset), row, 0, row.Length);
                    int output = ((y - crop.Y) * crop.Width + overlap.X - crop.X) * 3;
                    for (int x = 0; x < row.Length; x++)
                    {
                        result[output++] = (byte)row[x];
                        result[output++] = (byte)(row[x] >> 8);
                        result[output++] = (byte)(row[x] >> 16);
                    }
                }
            }
            return result;
        }

        internal static byte[] Read(IntPtr hwnd, Rectangle window, Rectangle crop)
        {
            if (!GraphicsCaptureSession.IsSupported()) throw new InvalidOperationException("Windows Graphics Capture is unavailable on this desktop.");
            var watch = Stopwatch.StartNew();
            var item = WindowItem(hwnd);
            var size = item.Size;
            var bounds = FrameBounds(hwnd, window, size);
            using (var device = CreateDevice())
            using (var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, size))
            using (var session = pool.CreateCaptureSession(item))
            {
                if (ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "IsCursorCaptureEnabled"))
                    session.IsCursorCaptureEnabled = false;
                session.StartCapture();
                Direct3D11CaptureFrame frame;
                while ((frame = pool.TryGetNextFrame()) == null)
                {
                    if (watch.ElapsedMilliseconds >= TimeoutMs) throw new TimeoutException("The window compositor did not deliver an image in time.");
                    Thread.Sleep(10);
                }
                using (frame)
                using (var surface = frame.Surface)
                {
                    if (FrameBounds(hwnd, window, frame.ContentSize) != bounds)
                        throw new InvalidOperationException("Window geometry changed during compositor capture. Capture the target again.");
                    var copy = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface);
                    while (copy.Status == AsyncStatus.Started)
                    {
                        if (watch.ElapsedMilliseconds >= TimeoutMs)
                        {
                            copy.Cancel();
                            throw new TimeoutException("Timed out reading window compositor pixels.");
                        }
                        Thread.Sleep(5);
                    }
                    try
                    {
                        using (var bitmap = copy.GetResults())
                        {
                            var requested = new Rectangle(checked(window.X + crop.X), checked(window.Y + crop.Y), crop.Width, crop.Height);
                            return ReadCrop(bitmap, bounds, requested);
                        }
                    }
                    finally { copy.Close(); }
                }
            }
        }
    }
}
