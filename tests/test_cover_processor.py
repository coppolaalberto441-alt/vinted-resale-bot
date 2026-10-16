import io
import unittest

import numpy as np
from PIL import Image

from cover_processor import composite_cover, UnsafeMask


class CoverTests(unittest.TestCase):
    def test_original_subject_pixels_and_logo_are_preserved(self):
        pixels = np.zeros((100, 80, 3), dtype='uint8')
        pixels[:] = (50, 70, 90)
        pixels[20:80, 15:65] = (211, 202, 178)
        pixels[35:38, 42:46] = (173, 12, 29)  # Logo: must not become a different colour.
        pixels[70:73, 18:22] = (89, 80, 73)  # Wear: must not be removed.
        alpha = np.zeros((100, 80), dtype='uint8')
        alpha[20:80, 15:65] = 255
        output, report = composite_cover(Image.fromarray(pixels), Image.fromarray(alpha))
        x, y = report['offset']
        np.testing.assert_array_equal(np.asarray(output)[y:y+60,x:x+50], pixels[20:80,15:65])
        self.assertEqual(output.getpixel((0, 0)), (247,247,247))
        self.assertNotIn('exif', output.info)

    def test_uncertain_empty_or_full_mask_is_rejected(self):
        source = Image.new('RGB',(100,100))
        for colour in (0,255):
            with self.assertRaises(UnsafeMask):
                composite_cover(source,Image.new('L',source.size,colour))
        with self.assertRaises(UnsafeMask):
            composite_cover(source,Image.new('L',(99,100),255))

    def test_cropped_original_is_flagged_not_reconstructed(self):
        alpha=np.zeros((100,100),dtype='uint8')
        alpha[0:75,20:80]=255
        _, report=composite_cover(Image.new('RGB',(100,100)),Image.fromarray(alpha))
        self.assertTrue(report['edge_touch'])


if __name__ == '__main__':
    unittest.main()
