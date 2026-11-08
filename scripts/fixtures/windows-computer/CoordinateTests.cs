using System;
using AgentOS.Computer;

// Pure arithmetic only. This test never reads or moves the desktop cursor.
internal static class CoordinateTests
{
    static void CheckAxis(int origin, int length)
    {
        for (int pixel = 0; pixel < length; pixel++)
        {
            int normalized = NativeDesktop.NormalizeMouseCoordinate(origin + pixel, origin, length);
            if (normalized < 0 || normalized > 65535 || (long)normalized * length / 65536 != pixel)
                throw new Exception("Absolute input missed pixel " + (origin + pixel) + " in extent " + length);
        }
    }

    static void RequireRejection(int coordinate, int origin, int length)
    {
        try { NativeDesktop.NormalizeMouseCoordinate(coordinate, origin, length); }
        catch (InvalidOperationException) { return; }
        throw new Exception("Unexpected normalized value for " + coordinate + " in extent " + length);
    }

    static void Main()
    {
        CheckAxis(-2560, 4480); // Secondary monitor to the left, including the observed x = -520.
        CheckAxis(-311, 1751); // Vertically offset monitor with an odd combined height.
        CheckAxis(0, 1);
        CheckAxis(-32768, 65536);
        RequireRejection(-2561, -2560, 4480);
        RequireRejection(1920, -2560, 4480);
        RequireRejection(0, 0, 0);
        RequireRejection(65536, 0, 65537); // No 16-bit absolute coordinate lands on this pixel.
    }
}
